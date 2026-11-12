# Contributing to Agent Threads

Thanks for helping. Issues and pull requests are welcome.

## Before you start

- Search the [open issues](https://github.com/rbcodelabs/agent-threads/issues) first. Issues labeled [`good first issue`](https://github.com/rbcodelabs/agent-threads/labels/good%20first%20issue) are a good place to begin.
- For a larger change, open an issue to discuss it before writing code.
- Questions and ideas are fine as issues too.

## Build and test

```bash
git clone https://github.com/rbcodelabs/agent-threads
cd agent-threads
npm install
npm run build        # output is in dist/
npx tsc --noEmit     # type check
npm test             # unit tests (vitest)
```

The full development workflow (worktrees, screenshot tests, real-app tests) is described in [process/development.md](process/development.md). Build-from-source and release details are in [docs/development.md](docs/development.md).

## Pull requests

- Work on a branch, keep each commit to one change, and add or update tests for behavior you change.
- Run `npx tsc --noEmit` and `npm test` before opening the PR.
- For UI changes, include screenshots in the PR description.
- Fill in the pull request template: what changed, what you ran, and what you observed.

## Compatibility

The plugin ID (`claude-threads`), install folder, command IDs, workspace view types and `claude_threads` MCP namespace keep their historical names on purpose. Please do not rename them.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
