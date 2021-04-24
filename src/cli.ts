#!/usr/bin/env node
import {
	array as CmdArray,
	boolean as CmdBoolean,
	command,
	flag,
	multioption,
	option,
	optional,
	run,
	string as CmdString
} from 'cmd-ts';
import { Listr } from 'listr2';
import { GloblistPacker } from './packer';
import { ProgressCallback, Steps } from './types';
import Package = require('../package.json');

const progressListeners: ProgressCallback[] = [];

// "tasks" in this sense are more slots for signals coming from the actual application - they aren't actually executing anything, just tracking progress

const TaskList = Steps.map((stepStr) => {
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

const tasks = new Listr(TaskList, {});

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
			description:
				'Files that are formatted like .gitignore - line delimited glob patterns to include or exclude.'
		}),
		useGitIgnoreFiles: flag({
			type: optional(CmdBoolean),
			long: 'use-gitignore-files',
			defaultValue: () => {
				return true;
			},
			description: 'Whether or not to check for, and use, .gitignore files as part of the ruleset'
		}),
		verbose: flag({
			type: optional(CmdBoolean),
			long: 'verbose',
			defaultValue: () => {
				return false;
			},
			description: 'Enable extra logging to the console / stdout'
		})
	},
	handler: async ({ rootDir, ignoreListFileNames, useGitIgnoreFiles, verbose }) => {
		tasks.run();
		await GloblistPacker({
			rootDir,
			ignoreListFileNames,
			useGitIgnoreFiles,
			verbose,
			onStepChange: (updatedStep) => {
				progressListeners.forEach((p) => p(updatedStep));
			}
		});
	}
});

run(app, process.argv.slice(2));
