import type { WalkerOptions } from 'ignore-walk';
import IgnoreWalk = require('ignore-walk');
import archiver = require('archiver');
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { removeEndSlash } from '../utils';
import { PackerOpts } from './types';

const DEFAULT_ARCHIVE_BASENAME = 'packed';
const DEFAULT_IGNORE_GLOBS = ['node_modules', '.git'];

function getAbsNormalized(base: string, relativePathNoSlashStart: string) {
	return path.normalize(`${base}${path.sep}${relativePathNoSlashStart}`);
}

function replaceLastInstanceInString(input: string, replace: string, replacement: string) {
	let output = input;
	const foundIndex = input.lastIndexOf(replace);
	if (foundIndex >= 0) {
		output = output.slice(0, foundIndex) + replacement;
	}

	return output;
}

export function GloblistPacker({
	rootDir,
	ignoreListFileNames = [],
	useGitIgnoreFiles = true,
	includeDefaultIgnores = true,
	includeEmpty = false,
	followSymlink = false,
	outDir,
	archiveName,
	archiveType = 'tar',
	archiveRootDirName,
	archiveOptions = {},
	maxFileCount,
	fileNameTransformer = () => true,
	onStepChange = () => {},
	verbose = false
}: PackerOpts) {
	return new Promise(async (resolve, reject) => {
		const logger = (...args: any[]) => {
			if (verbose) {
				console.log(...args);
			}
		};
		logger({
			rootDir,
			ignoreListFileNames,
			useGitIgnoreFiles,
			includeDefaultIgnores,
			includeEmpty,
			followSymlink,
			outDir,
			archiveName,
			archiveType,
			archiveRootDirName,
			archiveOptions,
			maxFileCount,
			verbose
		});
		const rootDirUnslashedEnd = removeEndSlash(rootDir);
		const ignoreListFilesBasenames = ignoreListFileNames.map((i) => path.basename(i));

		/**
		 * NOTE: Order ***really*** matters for ignores files array.
		 * @see https://github.com/npm/ignore-walk#options
		 */

		let ignoreFileNames = [];

		// @TODO - Improve?
		// This does not seem like the *optimal* approach, but unfortunately,
		// is the only one that works with ignore-walk. Since it order matters,
		// and the walker only takes files into account based on what actual
		// directory they reside in, injecting an actual file into the root dir
		// before it is walked is the only thing I can come up with right now.
		// Post-filtering the file list with something like `ignore()` would not
		// work because of the order issue (I could be excluding something that
		// a user provided list explicitly approved with `!{pattern}`
		const GENERATED_TEMP_IGNORE_FILENAME = `globlist-packer-defaults-${Date.now()}.ignore`;
		const GENERATED_TEMP_IGNORE_PATH = `${rootDirUnslashedEnd}${path.sep}${GENERATED_TEMP_IGNORE_FILENAME}`;
		if (includeDefaultIgnores) {
			ignoreFileNames.push(GENERATED_TEMP_IGNORE_FILENAME);
			DEFAULT_IGNORE_GLOBS.push(GENERATED_TEMP_IGNORE_FILENAME);
			await fse.writeFile(GENERATED_TEMP_IGNORE_PATH, DEFAULT_IGNORE_GLOBS.join('\n'));
		}

		if (useGitIgnoreFiles) {
			ignoreFileNames.push('.gitignore');
		}

		// Add user provided ignore lists last, so they can override everything else
		// Remember: order matters; this must come last.
		ignoreFileNames = ignoreFileNames.concat(ignoreListFilesBasenames);

		logger(ignoreFileNames);

		const walkerArgs: WalkerOptions = {
			path: rootDirUnslashedEnd,
			follow: followSymlink,
			ignoreFiles: ignoreFileNames,
			includeEmpty
		};

		onStepChange('Scanning input files');
		const fileListResult = await IgnoreWalk(walkerArgs);

		// IMMEDIATELY clean up the temp ignore file if used
		if (includeDefaultIgnores) {
			await fse.remove(GENERATED_TEMP_IGNORE_PATH);
			logger(`Deleted ${GENERATED_TEMP_IGNORE_PATH}`);
		}

		if (maxFileCount && fileListResult.length > maxFileCount) {
			return reject(`Matched file count of ${fileListResult.length} exceeds maxFileCount of ${maxFileCount}`);
		}

		logger(fileListResult);

		let archiveFileNameBaseNoExt: string | undefined = undefined;

		// Explicit option overrides everything else
		if (archiveName) {
			// Remove extension
			archiveFileNameBaseNoExt = archiveName.replace(path.extname(archiveName), '');
		}

		// First default = based on ignore list
		if (!archiveFileNameBaseNoExt) {
			const firstNonGitIgnoreList = ignoreListFilesBasenames.filter((f) => f !== '.gitignore')[0];
			if (firstNonGitIgnoreList) {
				archiveFileNameBaseNoExt = firstNonGitIgnoreList.replace(path.extname(firstNonGitIgnoreList), '');
			}
		}

		// Final fallback - hardcoded name
		if (!archiveFileNameBaseNoExt) {
			archiveFileNameBaseNoExt = DEFAULT_ARCHIVE_BASENAME;
		}

		// Add extension
		const archiveExt = archiveType === 'tar' ? '.tgz' : '.zip';
		const archiveBaseName = `${archiveFileNameBaseNoExt}${archiveExt}`;

		// Prepare archive *stream*
		let destinationDir = rootDirUnslashedEnd;
		if (outDir) {
			if (path.isAbsolute(outDir)) {
				destinationDir = removeEndSlash(outDir);
			} else {
				// Resolve relative path with rootDir
				destinationDir = removeEndSlash(path.resolve(rootDir, outDir));
			}
		}

		// Create stream and archiver instance
		const archiveAbsPath = `${destinationDir}${path.sep}${archiveBaseName}`;
		const archiveOutStream = fse.createWriteStream(archiveAbsPath);
		const archive = archiver(archiveType, {
			...archiveOptions,
			zlib: {
				level: 6,
				...(archiveOptions.zlib || {})
			}
		});
		// Attach listeners to archiver
		archiveOutStream.on('close', async () => {
			logger(`${archive.pointer()} total bytes`);
			logger('archiver has been finalized and the output file descriptor has closed.');
			// Cleanup temp dir
			onStepChange('Cleaning Up');
			await fse.remove(tempDirPath);
			logger(`Deleted ${tempDirPath}`);
			onStepChange('Done!');
			resolve(archiveAbsPath);
		});
		archive.on('error', reject);
		archive.on('warning', (err) => {
			if (err.code === 'ENOENT') {
				logger(err);
			} else {
				reject(err);
			}
		});
		// Hookup pipe
		archive.pipe(archiveOutStream);

		// Start prepping by creating a temporary directory
		const tempDirPath = await fse.mkdtemp(`${os.tmpdir()}${path.sep}`);
		let rootDestDirPath = tempDirPath;

		// If (pseudo) root dir is required, go ahead and create it
		if (archiveRootDirName) {
			rootDestDirPath = `${tempDirPath}${path.sep}${archiveRootDirName}`;
			await fse.mkdirp(path.normalize(rootDestDirPath));
		}

		onStepChange('Copying files');
		logger(`Copying ${fileListResult.length} file(s) to ${rootDestDirPath}`);

		await Promise.all(
			fileListResult.map(async (relativeFilePath) => {
				// NOTE: the walker only returns file paths, not directories.
				let absInputPath = getAbsNormalized(rootDir, relativeFilePath);
				let absDestPath = getAbsNormalized(rootDestDirPath, relativeFilePath);
				let baseName = path.basename(absInputPath);

				// Allow user-specified override of filename, or omission
				const userTransformResult = await fileNameTransformer({
					fileAbsPath: absInputPath,
					fileBaseName: baseName
				});

				if (userTransformResult === false) {
					return;
				}

				if (typeof userTransformResult === 'string') {
					// Return should be new *basename*
					const updatedBaseName = userTransformResult;
					absInputPath = replaceLastInstanceInString(absInputPath, baseName, updatedBaseName);
					absDestPath = replaceLastInstanceInString(absDestPath, baseName, updatedBaseName);
					baseName = updatedBaseName;
				}

				try {
					await fse.copyFile(absInputPath, absDestPath);
				} catch (e) {
					// Try creating dir
					const destDirPath = path.dirname(absDestPath);
					await fse.mkdirp(destDirPath);
					await fse.copyFile(absInputPath, absDestPath);
				}

				return;
			})
		);

		// Archive the temp dir
		onStepChange('Compressing');
		archive.directory(tempDirPath, false);

		onStepChange('Finalizing and saving archive');
		archive.finalize();
	});
}
