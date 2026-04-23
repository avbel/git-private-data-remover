# Git Private Data Remover

A TypeScript/Bun CLI tool to remove accidentally committed private data from git history. It surgically rewrites only the specific lines in their originating commits, leaving all other changes untouched.

## Features

- **Surgical precision**: Targets only specific lines, preserves all other commits and files
- **Interactive prompts**: Asks for replacement text for each line
- **Dry-run mode**: Preview changes without modifying history
- **Automatic backup**: Creates a backup branch before rewriting
- **Force-push warning**: Detects remote upstream and warns about force-push requirements
- **Git version check**: Verifies git supports required features
- **Storage cleanup**: Compresses git storage to remove traces of old data

## Safety Features

- **Backup branch**: Automatically creates `backup/<branch>/<timestamp>` before rewriting
- **Content validation**: Verifies line content matches before replacement
- **Remote warning**: Warns if repository has a remote upstream
- **Force-push reminder**: Shows the exact command needed after rewrite

## Privacy & Control

- **Your data stays private**: All replacement text is entered via interactive prompts — nothing is passed as command-line arguments, so your private data will never be stored in shell history
- **Full control**: You decide which commits to modify. Each commit is presented for confirmation with the exact lines it contains — no automatic rewrites, no black boxes
- **Transparent process**: Every step is shown and requires your explicit approval before any changes are made


## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- Git >= 2.0

## Installation

```bash
bun install
```

## Usage

```bash
bun run src/index.ts -w <working-directory> -f <file> -l <line-spec> [options]
```

### Options

| Flag | Description |
|------|-------------|
| `-w, --working-directory <path>` | Directory of the git repository to operate on (required) |
| `-f, --file <path>` | File containing private data (required) |
| `-l, --lines <spec>` | Line number(s) to remove.  Format: `10` for single line, `10-20` for range (required) |
| `-d, --dry-run` | Show what would be changed without modifying history |
| `-h, --help` | Show help message |

### Examples

Remove a single line:

```bash
bun run src/index.ts -w ../some-repo -f config.json -l 15
```

Remove multiple lines and ranges:

```bash
bun run src/index.ts -w ../some-repo -f .env -l 5,10-15
```

Dry-run to preview changes:

```bash
bun run src/index.ts -w ../some-repo -f secrets.txt -l 3-7 --dry-run
```

## How It Works

1. **Parse line specs**: Validates and parses line numbers/ranges
2. **Git blame analysis**: Uses `git blame -L` to find the originating commit for each line
3. **Interactive prompts**: Asks for replacement text for each line
4. **Group by commit**: Organizes replacements by their originating commit
5. **Backup creation**: Creates a backup branch before any modifications
6. **Interactive rebase**: Uses `git rebase -i` with `GIT_SEQUENCE_EDITOR` to stop at each target commit
7. **Commit amendment**: Applies replacements and amends the commit
8. **Storage cleanup**: Runs `git gc --aggressive --prune=now` to remove old objects

## Development

### Running Tests

```bash
bun test
```

### Linting

```bash
bun run lint
```

Auto-fix linting issues:

```bash
bun run lint:fix
```

### Git Hooks

This project uses [Lefthook](https://github.com/evilmartians/lefthook) to run linting on every commit. Install hooks:

```bash
bun run prepare
```


## License

MIT
