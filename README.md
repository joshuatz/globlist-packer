# Globlist-Packer
> CLI and NodeJS utility for *packing* files based on glob pattern lists, such as `.gitignore` files.

## Demo
<details>
	<summary>Show / Hide Demo</summary>

![Animated GIF showing a console, running `npx globpack -i dist.packlistignore`, seeing the tool run, and then inspecting the zip output with `zipinfo`](demo.gif)
</details>

## Installation
Use it with / without installing:

```bash
npx globlist-packer
```

For frequent use, you should really install the package:

```bash
# Globally
npm i -g globlist-packer

# Local devDependency
npm i -D globlist-packer
```

Once it is installed, it also exposes two callable names (through `.bin`)

```bash
globlist-packer

# Or

globpack
```

## Usage
Despite the number of configurable options, this tool is designed to be "zero-config", and can work out-of-the-box with minimal settings, for the majority of use-cases.

For example, if you are working with `git` and wanted to pack your current repo directory to an archive, while keeping files out that are ignored by `.gitignore`, it should be possible with just:

```bash
npx globlist-packer
```

Or, if you want a specific globlist to be used:

```bash
# This will create `dist.zip` in same directory, based on glob(s) contained in `dist.ignorelist`
npx globlist-packer -i dist.ignorelist
```

You can also use it via JS / TS, by installing the package and then importing:

```js
// ESM import
import {GloblistPacker} from 'globlist-packer';

GloblistPacker({
	ignoreListFileNames: ['dist.ignorelist'],
	// This will create `distribution.zip`
	archiveName: 'distribution',
	archiveType: 'zip'
});
```

> For more advanced uses, see options below, and examples under ["Usage Examples"](#usage-examples).

As much as possible, I try to make all options and flags available through both the main JS entry-point, as well as through the CLI. Refer to the table below, the source code, or use `--help` with the CLI.

Option Key | CLI | Description | Type | Default
--- | --- | --- | --- | ---
`rootDir` | `root-dir` | Used as the entry point to the filewalker, and used as the base to resolve any relative paths that are passed | `string` | `process.cwd()` (working directory)
`ignoreListFileNames` | `ignorelist-files` or `-i` | Files that are formatted like .gitignore - line delimited glob patterns to include or exclude.<br/><br/>Warning: Order matters! | `string[]` | `[]` (or `['.gitignore']` if `useGitIgnoreFiles === true`)
`useGitIgnoreFiles` | `use-gitignore-files` | Whether or not to check for, and use, .gitignore files as part of the ruleset | `boolean` | `true`
`includeDefaultIgnores` | `include-default-ignores` | If true, adds some default excludes that should apply to most projects and helps avoid accidental bundling | `boolean` | `true`
`includeEmpty` | `include-empty` | Include empty directories in the output archive | `boolean` | `false`
`followSymlink` | `follow-symlink` | Whether or not to follow symlinks when copying files to the archive. | `boolean` | `false`
`outDir` | `out-dir` or `-d` | Where to save the generated archive(s). Defaults to the root directory and/or calling directory. | `string` | The root directory, or calling directory.
`copyFilesTo` | `copy-files-to` | Path to directory to copy all matching files to, instead of creating a packed archive. If used, nullifies a lot of other settings, and causes no archive to be generated. | `string` | NA
`archiveName` | `archive-name` or `-n` | Name for the generated archive.<br/>File extension is optional, and will be overwritten anyways, based on `archiveType` | `string` | Will default to primary non-gitignore ignore file, and if that is not available, to simply `packed.{ext}`
`archiveType` | `archive-type` or `-t` | Type of generated archive file. Not the same as file extension. | `'tar'` or  `'zip'` | `'zip'`
`archiveRootDirName` | `archive-root-dir-name` | Inject a single folder in the root of the archive, with this name, which will contain all collected files. | `string` | NA / Not used
`maxFileCount` | `max-files` or `-m` | If you are worried about accidentally including a massive number of files and you want to bail out early of the archiving process if this happens, you can set a hard cap with this option. | `number` |  NA / Infinity
`verbose` | `verbose` | Enable extra logging to the console / stdout | `boolean` | `false`

The following options are ***only*** available when calling the program via JS/TS.

Option Key | Description
--- | ---
`archiveOptions` | You can extend / override the options that are passed to [the `archiver` package](https://www.npmjs.com/package/archiver) that this program uses.
`fileNameTransformer` | You can pass a callback function here that will receive the path and name of a file that is being considered for packing. You can return `false` to stop the file from being packed, a `string` to rename the file in the archive, or `undefined` (default return) or `true` to process the file as-is.
`onStepChange` | Receive updates when the program has moved between steps. For internal use.

## Usage Examples
Example scenario(s):

<details>
	<summary>Scenario: Overriding <code>.gitignore</code></summary>

Files:
```
.
├── package-lock.json
├── package.json
├── README.md
├── build/
│   ├── index.html
│   ├── index.js
│   └── style.css
├── src/
│   ├── index.js
│   └── style.css
├── vendor/
│   └── vendor-bundle.js
├── node_modules/
│   └── ... (lots of files)
└── tests/
    └── ... (lots of files)
```


`.gitignore`
```
node_modules
build
vendor
```

Say that we want to share this project with someone else, but not the source code - we want to give them the pre-built project, with as few files as possible. We could create a pack list for this tool that looks something like this:

`dist.packlistignore`
```
# Remove all source code, and unneeded files
src
tests
package-lock.json
package.json

# Block recursive packing if ran again
dist.tgz
dist.zip

# OVERRIDE ignores in .gitignore, adding back build files and artifacts
!build
!vendor
```

Now, we can create our shareable archive file with a single command, as many times as we want:

```bash
globlist-packer -i dist.packlistignore
```
</details>

## Special Use-Case: Copying Files to Directory
This is semi-experimental, as it is not the main intended use of the program, but for convenience I have added an option that lets you use this to *only* copy files (based on globlists) to a target directory, and skip the archive / tar / zip generation.

To use this feature, pass a string to the `copy-files-to` option (or `copyFilesTo` via JS API) - this will cause the tool to skip all archiver steps and only handle copying files. You can still use all the input control options (such as `ignorelist-files`, `include-default-ignores`, etc.).

The truth is that this feature complicates things a little bit. For example, if the target output directory is nested inside the root directory, then I have to block files that live inside the output directory, to prevent recursive copying in case the tool is ran more than once without clearing the output.

## Design Decisions
This tool is primarily a wrapper around [the `ignore-walk` package](https://www.npmjs.com/package/ignore-walk). Due to some limitations in that package, and complexities of resolving glob patterns (remember: you can have *negation* in glob lists), if the `includeDefaultIgnores` option is true (which is default), this tool will actually temporarily inject a ignore glob list file in your project root directory.

Multiple considerations are taken around this action:

- The file only exists for as long as it takes to walk the file tree. This can be as short as milliseconds.
- The file is given a long and dynamic filename - highly unlikely to collide with any existing files
	- If, somehow, a file already exists with that name, the program will halt and not overwrite the existing file

## Change Notes
Version | Date | Notes
--- | --- | ---
`v0.1.0` | {RELEASE_DATE} | Initial Release 🚀

## Related Projects
Of course, after building this tool I immediately found some that might have fit the bill for what I needed. However, all of these are slightly different from what this tool offers:

- [palletjack](https://www.npmjs.com/package/palletjack)
- [gitzip](https://www.npmjs.com/package/@bung87/gitzip)