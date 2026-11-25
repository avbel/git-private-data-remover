<p align="center">
  <img src="assets/logo.svg" alt="Git Private Data Remover" width="600" style="width: 100%; max-width: 600px; height: auto;">
</p>

# Git Private Data Remover

A TypeScript CLI tool (runs on Node.js 26+ or Bun) to remove accidentally committed private data from git history. It surgically rewrites only the specific lines in their originating commits, leaving all other changes untouched.

## Features

- **Surgical precision**: Targets only specific lines, preserves all other commits and files
- **Interactive prompts**: Asks for replacement text for each line
- **Dry-run mode**: Preview changes without modifying history
- **Automatic backup**: Creates a backup branch before rewriting
- **Storage cleanup**: Expires the reflog and compresses git storage to drop the old objects
- **Verification**: After rewriting, scans every local ref for the original data and tells you exactly which commits and refs still hold it
- **Modern Git aware**: Uses the atomic `git history fixup` (Git 2.55+) when available, falling back to `git rebase -i` on older Git
- **SHA-256 repositories**: Works with repositories created with `git init --object-format=sha256`
- **Runs anywhere**: Node.js 26+ (native TypeScript, no build step) or Bun

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

- [Node.js](https://nodejs.org) >= 26 **or** [Bun](https://bun.sh) >= 1.0
- Git >= 2.22 (Git >= 2.55 recommended — see [Rewrite engines](#rewrite-engines))
- (Optional, recommended for `--rm`) [`git filter-repo`](https://github.com/newren/git-filter-repo) — see [Removing a file from history](#removing-a-file-from-history)

## Installation

```bash
bun install   # or: npm install
```

### Installing `git filter-repo` (recommended for `--rm`)

`git filter-repo` is the [tool recommended by the Git project](https://git-scm.com/docs/git-filter-branch#_warning) for rewriting history; it is faster and safer than the legacy `git filter-branch`. When the `--rm` flag is used, this tool prefers `git filter-repo` and falls back to `git filter-branch` only if it is not installed.

| Platform | Command |
|----------|---------|
| macOS (Homebrew) | `brew install git-filter-repo` |
| Debian / Ubuntu | `sudo apt install git-filter-repo` |
| Fedora | `sudo dnf install git-filter-repo` |
| Arch Linux | `sudo pacman -S git-filter-repo` |
| Windows (Scoop) | `scoop install git-filter-repo` |
| Any platform with Python | `pip install git-filter-repo` |

Verify the install:

```bash
git filter-repo --version
```

## Usage

```bash
node src/index.ts -w <working-directory> -f <file> -l <line-spec> [options]   # Node.js 26+
bun run src/index.ts -w <working-directory> -f <file> -l <line-spec> [options] # Bun
```

The examples below use Bun; replace `bun run` with `node` to run on Node.js.

### Options

| Flag | Description |
|------|-------------|
| `-w, --working-directory <path>` | Directory of the git repository, or any directory inside it (required) |
| `-f, --file <path>` | File containing private data, relative to the working directory (required) |
| `-l, --lines <spec>` | Line number(s) to remove.  Format: `10` for single line, `10-20` for range (required unless --rm) |
| `-r, --rm` | Completely remove the file from the current branch's history |
| `-d, --dry-run` | Show what would be changed without modifying history |
| `-h, --help` | Show help message |

| Environment variable | Description |
|----------------------|-------------|
| `GIT_PRIVATE_DATA_REMOVER_ENGINE` | `auto` (default), `history` or `rebase` — force a [rewrite engine](#rewrite-engines) |

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

Remove an entire file from history:

```bash
bun run src/index.ts -w ../some-repo -f ./my-private-key.pem --rm
```

Dry-run file removal:

```bash
bun run src/index.ts -w ../some-repo -f ./my-private-key.pem --rm --dry-run
```

## How It Works

1. **Parse line specs**: Validates and parses line numbers/ranges
2. **Git blame analysis**: Uses `git blame -L` to find the originating commit for each line
3. **Interactive prompts**: Asks for replacement text for each line
4. **Group by commit**: Organizes replacements by their originating commit
5. **Engine selection**: Picks `git history fixup` or `git rebase -i` (see below)
6. **Backup creation**: Creates a backup branch before any modifications
7. **Rewrite**: Applies the replacements to each originating commit and replays the commits after it
8. **Storage cleanup**: Expires the reflog and runs `git gc --aggressive --prune=now` to remove old objects
9. **Verification**: Scans every local ref (`git log --all`) for the original lines and reports any commit that still contains them, together with the refs keeping that commit alive

## Rewrite engines

Line replacements are applied with one of two engines:

- **`git history fixup` (preferred, Git 2.55+)** — Git's experimental `git history` command applies a staged change to an earlier commit and replays its descendants in one step. It never leaves a half-finished rebase behind: if anything would conflict, it aborts before any ref is updated. The tool runs one fixup per target commit, newest first, with `--update-refs=head` (so only the current branch moves and the backup branch keeps the original history) and `--empty=keep` (so a commit that becomes empty is kept rather than dropped).
- **`git rebase -i` (fallback)** — used when `git history fixup` is not available, or when the file was renamed after one of the target commits, because the rebase engine edits the file under its original name.

Detection is based on what `git history fixup -h` advertises, not on the version number, because the command is still experimental. Set `GIT_PRIVATE_DATA_REMOVER_ENGINE=rebase` to force the classic engine, or `history` to require the new one. `--dry-run` prints which engine would be used and the exact plan.

## Removing a file from history

The `--rm` flag removes a file from every commit on the current branch. Two underlying tools can do this:

- **`git filter-repo` (preferred)** — fast, actively maintained, and the tool the Git project itself recommends for history rewrites. Used automatically when available. See [Installing `git filter-repo`](#installing-git-filter-repo-recommended-for---rm) above. It is run with `--refs <current-branch>` so that the backup branch, other local branches and the `origin` remote are left untouched.
- **`git filter-branch` (fallback)** — bundled with Git but deprecated, significantly slower, and unsafe on large repositories. Used only when `git filter-repo` is not installed.

If you plan to use `--rm`, install `git filter-repo` first. If the file also exists on other branches, the verification step will list them; re-run the tool on each of those branches or delete them.

## Limitations

- Always create a remote backup (e.g., push to a temporary remote branch) before rewriting history.
- Only the current branch is rewritten. Other local branches and remote-tracking refs (`origin/*`) keep the original commits, so the old objects stay in `.git` until you force-push, run `git fetch --prune`, and run `git gc --prune=now`. The verification step tells you when this is the case.
- `git blame` only reports the **most recent** commit that touched a line. If a secret line was edited in several commits (for example the key was rotated in place), only the latest value is rewritten; earlier values remain in earlier commits. Targeting those earlier commits by hand causes a rebase conflict, which the tool detects and rolls back. Use `--rm` for that file instead, or rewrite the commits one at a time from oldest to newest.
- Merge commits are not supported in the rewrite range when removing individual lines (this applies to both engines).
- Git treats changes on adjacent lines as a conflict. If a later commit edited the line directly before or after the secret (for example, appended a new line right after it), the rewrite conflicts and the tool restores the backup. Use `--rm` for that file, or redact the neighbouring commit first.
- Replacement text must be a single line, so a line can be blanked but not deleted.
- HEAD must be on a branch (detached HEAD is refused).

## Development

### Running Tests

The test suite uses `node:test`, so it runs under both runtimes:

```bash
bun test          # Bun
node --test       # Node.js 26+
```

Tests for the `git history` engine are skipped (and reported as skipped) when the installed Git is older than 2.55.

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
