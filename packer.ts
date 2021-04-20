import type { WalkerOptions } from 'ignore-walk';
import IgnoreWalk = require('ignore-walk');
import archiver = require('archiver');
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { removeEndSlash } from './utils';
import { PackerOpts } from './types';

const DEFAULT_ARCHIVE_BASENAME = 'packed';
const BUNDLED_IGNORES_ABS_FILEPATH = path.normalize(`${__dirname}${path.sep}default-ignores.txt`);

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
	ignoreListFiles = [],
	useGitIgnoreInput = true,
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
	onStepChange = () => {}
}: PackerOpts) {
	return new Promise(async (resolve, reject) => {
		const rootDirUnslashedEnd = removeEndSlash(rootDir);
		const ignoreListFilesBasenames = ignoreListFiles.map((i) => path.basename(i));

		/**
		 * NOTE: Order ***really*** matters for ignores files array.
		 * @see https://github.com/npm/ignore-walk#options
		 */

		let ignoreFiles = [];

		// @TODO this is not working
		// I think that ignore-walk only applies ignore files if they reside at the same level. So maybe if I prefixed every line of the ignore file with the absolute path of rootdir?
		if (includeDefaultIgnores) {
			ignoreFiles.push(BUNDLED_IGNORES_ABS_FILEPATH);
		}

		if (useGitIgnoreInput) {
			ignoreFiles.push('.gitignore');
		}

		// Add user provided ignore lists last, so they can override everything else
		ignoreFiles = ignoreFiles.concat(ignoreListFilesBasenames);

		console.log(ignoreFiles);

		const walkerArgs: WalkerOptions = {
			path: rootDirUnslashedEnd,
			follow: followSymlink,
			ignoreFiles,
			includeEmpty
		};

		onStepChange('Scanning input files');
		const fileListResult = await IgnoreWalk(walkerArgs);

		if (maxFileCount && fileListResult.length > maxFileCount) {
			return reject(`Matched file count of ${fileListResult.length} exceeds maxFileCount of ${maxFileCount}`);
		}

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
			console.log(`${archive.pointer()} total bytes`);
			console.log('archiver has been finalized and the output file descriptor has closed.');
			// Cleanup temp dir
			onStepChange('Cleaning Up');
			await fse.remove(tempDirPath);
			console.log(`Deleted ${tempDirPath}`);
			onStepChange('Done!');
			resolve(archiveAbsPath);
		});
		archive.on('error', reject);
		archive.on('warning', (err) => {
			if (err.code === 'ENOENT') {
				console.log(err);
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
