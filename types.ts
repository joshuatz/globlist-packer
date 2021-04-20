import type archiver from 'archiver';
import type { ArchiverOptions } from 'archiver';
export const Steps = [
	'Scanning input files',
	'Copying files',
	'Compressing',
	'Finalizing and saving archive',
	'Cleaning Up',
	'Done!'
] as const;

interface TransformerCbProps {
	fileBaseName: string;
	fileAbsPath: string;
}

export type FileNameTransformer = (
	props: TransformerCbProps
) => void | boolean | string | Promise<void> | Promise<boolean> | Promise<string>;

export interface PackerOpts {
	/**
	 * Used as the entry point to the filewalker, and used as the base to resolve any relative paths that are passed
	 * - Should be an absolute path
	 */
	rootDir: string;
	/**
	 * These should use the same glob syntax as `.gitignore` files, and are the main input (aside from `rootDir`) to the program in terms of computing what gets included in the archive
	 * - Just like `.gitignore`, you can override previous exclusions
	 * - Order matters!
	 * - Can be absolute or relative file paths
	 */
	ignoreListFiles?: string[];
	/**
	 * Whether or not to check for, and use, .gitignore files as part of the ruleset
	 * @default true
	 */
	useGitIgnoreInput?: boolean;
	/**
	 * If true, adds some default excludes that should apply to most projects and helps avoid accidental bundling
	 * @default true
	 * @TODO implementation
	 */
	includeDefaultIgnores?: boolean;
	/**
	 * Include empty directories in the archive
	 * @default false
	 */
	includeEmpty?: boolean;
	/**
	 * Whether or not to follow symlinks when copying files to the archive.
	 * @default false
	 */
	followSymlink?: boolean;
	/**
	 * Where to save the generated archive(s)
	 * @default PackerOpts.rootDir
	 */
	outDir?: string;
	/**
	 * Name for the generated archive.
	 * - Will default to primary non-gitignore ignore file, and if that is not available, to simply `packed.{ext}`
	 * - File extension is optional, and will be overwritten anyways, based on `archiveType`
	 */
	archiveName?: string;
	/**
	 * Type of generated archive file
	 * @default 'tar'
	 */
	archiveType?: archiver.Format;
	/**
	 * Inject a single folder in the root of the archive, with this name, which will contain all collected files.
	 * - This is desired for certain types of distributions, where you need your app name or plugin name to be the root folder, but you might not have that structure in your source code.
	 * - If input file is `a.txt`, and this is set to `my-app`, then archive will contain `my-app/a.txt` instead of just `a.txt` in root
	 */
	archiveRootDirName?: string;
	/**
	 * Archiver options
	 */
	archiveOptions?: ArchiverOptions;
	/**
	 * If you are worried about accidentally including a massive number of files and you want to bail out early of the archiving process if this happens, you can set a hard cap with this option.
	 */
	maxFileCount?: number;
	/**
	 * A callback function that will be called on each file to allow for a rename (or dynamic omission) before packing
	 */
	fileNameTransformer?: FileNameTransformer;
	/**
	 * A callback to track progress
	 */
	onStepChange?: (step: typeof Steps[number]) => void;
}
