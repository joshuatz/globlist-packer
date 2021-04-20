export function removeEndSlash(input: string) {
	return input.replace(/[/\\]+$/, '');
}
