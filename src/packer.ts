import Archiver from 'archiver';
import fse from 'fs-extra';
import type { WalkerOptions } from 'ignore-walk';
import IgnoreWalk from 'ignore-walk';
import os from 'os';
import path from 'path';
import { PackerOpts } from './types';
import { removeEndSlash } from './utils';

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
	rootDir: inputRootDir,
	ignoreListFileNames = [],
	useGitIgnoreFiles = true,
	includeDefaultIgnores = true,
	includeEmpty = false,
	followSymlink = false,
	outDir,
	copyFilesTo,
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

		/**
		 * Should be populated before, and then used during, the file walking process. Any directories in this path will be blocked from being added, **OR** their descendants.
		 * - Use with caution
		 */
		const blockFolders: string[] = [];

		// Resolve some input paths
		const rootDir: string = typeof inputRootDir === 'string' ? inputRootDir : process.cwd();
		const rootDirUnslashedEnd = removeEndSlash(rootDir);
		if (typeof copyFilesTo === 'string') {
			if (path.isAbsolute(copyFilesTo)) {
				copyFilesTo = removeEndSlash(copyFilesTo);
			} else {
				// Resolve relative path with rootDir
				copyFilesTo = removeEndSlash(path.resolve(rootDir, copyFilesTo));
			}
			// Make sure that there is no recursive copying going on if the tool is ran more than once
			blockFolders.push(copyFilesTo);
		} else {
			copyFilesTo = undefined;
		}
		// This might be used, depending on inputs
		let tempDirPath: string | null = null;

		// Safety check - if output is folder instead of archive, make sure output dir is not same as input
		if (copyFilesTo) {
			if (path.normalize(copyFilesTo) === path.normalize(rootDirUnslashedEnd)) {
				throw new Error(
					'Stopping process! - copyFilesTo is the same directory as rootDir - this would overrwrite files in-place and is likely unwanted.'
				);
			}
		}

		logger({
			rootDir,
			ignoreListFileNames,
			useGitIgnoreFiles,
			includeDefaultIgnores,
			includeEmpty,
			followSymlink,
			outDir,
			copyFilesTo,
			archiveName,
			archiveType,
			archiveRootDirName,
			archiveOptions,
			maxFileCount,
			verbose
		});

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
			const collidingFileExists = await fse.pathExists(GENERATED_TEMP_IGNORE_PATH);
			if (!collidingFileExists) {
				await fse.writeFile(GENERATED_TEMP_IGNORE_PATH, DEFAULT_IGNORE_GLOBS.join('\n'));
			} else {
				throw new Error(`Fatal: Failed to create temporary ignore file at ${GENERATED_TEMP_IGNORE_PATH}`);
			}
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

		logger('Scanned files', fileListResult);

		// Start prepping for file copying, by readying the target directory
		/**
		 * The path of the root (most parent) folder into which files are copied
		 */
		let rootDestDirPath: string;
		/**
		 * The actual destination path for which files are cloned into. In the case of a pseudo parent (injected by options), this will differ from `rootDestDirPath`, otherwise, they should be equal
		 */
		let copyDestDirPath: string;
		if (copyFilesTo) {
			await fse.ensureDir(copyFilesTo);
			rootDestDirPath = copyFilesTo;
		} else {
			// Use OS temp dir
			tempDirPath = await fse.mkdtemp(`${os.tmpdir()}${path.sep}`);
			rootDestDirPath = tempDirPath;
		}
		copyDestDirPath = rootDestDirPath;

		// If (pseudo) root dir is required, go ahead and create it
		if (archiveRootDirName) {
			copyDestDirPath = `${removeEndSlash(rootDestDirPath)}${path.sep}${archiveRootDirName}`;
			await fse.mkdirp(path.normalize(copyDestDirPath));
		}

		onStepChange('Copying files');
		logger(`Copying ${fileListResult.length} file(s) to ${copyDestDirPath}`);

		const blockedFiles: Array<{
			absInputPath: string;
			blockedBy: string;
		}> = [];
		const copiedFilesRelativePaths: string[] = [];
		await Promise.all(
			fileListResult.map(async (relativeFilePath) => {
				// NOTE: the walker only returns file paths, not directories.
				let absInputPath = getAbsNormalized(rootDir, relativeFilePath);
				let absDestPath = getAbsNormalized(copyDestDirPath, relativeFilePath);
				let baseName = path.basename(absInputPath);

				// Check for high priority blocks
				for (const blockFolder of blockFolders) {
					if (absInputPath.includes(path.normalize(blockFolder))) {
						blockedFiles.push({
							absInputPath,
							blockedBy: blockFolder
						});
						return;
					}
				}

				// Allow user-specified override of filename, or omission
				const userTransformResult = await fileNameTransformer({
					fileAbsPath: absInputPath,
					fileBaseName: baseName
				});

				if (userTransformResult === false) {
					blockedFiles.push({
						absInputPath,
						blockedBy: 'user provided fileNameTransformer'
					});
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

				copiedFilesRelativePaths.push(relativeFilePath);

				return;
			})
		);

		if (verbose && blockedFiles.length) {
			console.table(blockedFiles);
		}

		logger('Final list of copied files:', copiedFilesRelativePaths);

		// Skip archiver step - just copied files
		if (!!copyFilesTo) {
			// Nothing else to do - we already copied files
			onStepChange('Done!');
		}
		// Regular archiver mode
		else {
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
			const archive = Archiver(archiveType, {
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
				await fse.remove(tempDirPath!);
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

			// Archive the temp dir
			onStepChange('Compressing');
			archive.directory(rootDestDirPath, false);

			onStepChange('Finalizing and saving archive');
			archive.finalize();
		}
	});
}
