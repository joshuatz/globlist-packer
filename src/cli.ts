#!/usr/bin/env node
import {
	array as CmdArray,
	boolean as CmdBoolean,
	command,
	flag,
	multioption,
	number as CmdNumber,
	oneOf,
	option,
	optional,
	run,
	string as CmdString
} from 'cmd-ts';
import { Listr } from 'listr2';
import { GloblistPacker } from './packer';
import { ArchiveType, ArchiveTypeOptionsArr, ProgressCallback, Step, Steps } from './types';
import Package from '../package.json';

const progressListeners: ProgressCallback[] = [];

// "tasks" in this sense are more slots for signals coming from the actual application - they aren't actually executing anything, just tracking progress

function getListrTasks(skipSteps?: Step[]) {
	const TaskList = Steps.filter((s) => !skipSteps?.includes(s)).map((stepStr) => {
		const taskCompleteSignal = new Promise<void>((res) => {
			progressListeners.push((updatedStep) => {
				if (updatedStep === stepStr) {
					res();
				}
			});
		});
		return {
			title: stepStr,
			task: () => taskCompleteSignal
		};
	});
	return new Listr(TaskList, {});
}

const app = command({
	name: Package.name,
	version: Package.version,
	description: Package.description,
	args: {
		rootDir: option({
			type: CmdString,
			long: 'root-dir',
			defaultValue: () => {
				return process.cwd();
			},
			defaultValueIsSerializable: true,
			description:
				'Used as the entry point to the filewalker, and used as the base to resolve any relative paths that are passed'
		}),
		ignoreListFileNames: multioption({
			type: CmdArray(CmdString),
			long: 'ignorelist-files',
			short: 'i',
			description:
				'Files that are formatted like .gitignore - line delimited glob patterns to include or exclude.\n\tWarning: Order matters!'
		}),
		useGitIgnoreFiles: flag({
			type: optional(CmdBoolean),
			long: 'use-gitignore-files',
			defaultValue: () => {
				return true;
			},
			defaultValueIsSerializable: true,
			description: 'Whether or not to check for, and use, .gitignore files as part of the ruleset'
		}),
		includeDefaultIgnores: flag({
			type: optional(CmdBoolean),
			long: 'include-default-ignores',
			defaultValue: () => {
				return true;
			},
			defaultValueIsSerializable: true,
			description:
				'If true, adds some default excludes that should apply to most projects and helps avoid accidental bundling'
		}),
		includeEmpty: flag({
			type: optional(CmdBoolean),
			long: 'include-empty',
			defaultValue: () => {
				return false;
			},
			defaultValueIsSerializable: true,
			description: 'Include empty directories in the output archive'
		}),
		followSymlink: flag({
			type: optional(CmdBoolean),
			long: 'follow-symlink',
			defaultValue: () => {
				return false;
			},
			defaultValueIsSerializable: true,
			description: 'Whether or not to follow symlinks when copying files to the archive.'
		}),
		outDir: option({
			type: optional(CmdString),
			long: 'out-dir',
			short: 'd',
			description:
				'Where to save the generated archive(s). Defaults to the root directory and/or calling directory.'
		}),
		copyFilesTo: option({
			type: optional(CmdString),
			long: 'copy-files-to',
			description:
				'Path to directory to copy all matching files to, instead of creating a packed archive. If used, nullifies a lot of other settings, and causes no archive to be generated.'
		}),
		archiveName: option({
			type: optional(CmdString),
			long: 'archive-name',
			short: 'n',
			description:
				'Name for the generated archive.\n\tWill default to primary non-gitignore ignore file, and if that is not available, to simply `packed.{ext}`.\n\tFile extension is optional, and will be overwritten anyways, based on `archiveType`'
		}),
		archiveType: option({
			type: oneOf(ArchiveTypeOptionsArr),
			long: 'archive-type',
			short: 't',
			defaultValue: () => {
				return 'tar' as ArchiveType;
			},
			defaultValueIsSerializable: true,
			description: 'Type of generated archive file. Not the same as file extension.'
		}),
		archiveRootDirName: option({
			type: optional(CmdString),
			long: 'archive-root-dir-name',
			description:
				'Inject a single folder in the root of the archive, with this name, which will contain all collected files.'
		}),
		maxFileCount: option({
			type: optional(CmdNumber),
			long: 'max-files',
			short: 'm',
			description:
				'If you are worried about accidentally including a massive number of files and you want to bail out early of the archiving process if this happens, you can set a hard cap with this option.'
		}),
		verbose: flag({
			type: optional(CmdBoolean),
			long: 'verbose',
			defaultValue: () => {
				return false;
			},
			defaultValueIsSerializable: true,
			description: 'Enable extra logging to the console / stdout'
		})
	},
	handler: async (args) => {
		let skipTasks: Step[] = [];

		// If copying to dir, instead of archiving, make sure to not wait on archive task emits
		if (!!args.copyFilesTo) {
			skipTasks = ['Compressing', 'Finalizing and saving archive', 'Cleaning Up'];
		}

		const tasks = getListrTasks(skipTasks);
		tasks.run();
		await GloblistPacker({
			...args,
			onStepChange: (updatedStep) => {
				progressListeners.forEach((p) => p(updatedStep));
			}
		});
	}
});

run(app, process.argv.slice(2));
