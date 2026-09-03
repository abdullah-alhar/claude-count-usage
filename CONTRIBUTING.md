# Contributing to Claude Count Usage

Thank you for your interest in contributing to **Claude Count Usage**! Contributions, bug reports, feature requests, documentation improvements, and code improvements are welcome.

## Before You Start

Please read the following files before contributing:

* [README.md](README.md)
* [SECURITY.md](SECURITY.md)
* [PRIVACY.md](PRIVACY.md)
* [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

For security vulnerabilities, please **do not open a public GitHub issue**. Follow the instructions in `SECURITY.md`.

## How to Contribute

### 1. Fork the Repository

Fork the repository to your own GitHub account.

### 2. Clone Your Fork

```bash
git clone https://github.com/YOUR-USERNAME/claude-count-usage.git
cd claude-count-usage
```

### 3. Create a Branch

Create a separate branch for your change:

```bash
git checkout -b feature/my-feature
```

For a bug fix:

```bash
git checkout -b fix/my-fix
```

Use descriptive branch names whenever possible.

### 4. Make Your Changes

Make your changes while keeping the existing project structure and coding style.

Before submitting your changes:

* Test the feature or fix.
* Make sure existing functionality still works.
* Remove unnecessary debug code.
* Do not commit passwords, API keys, tokens, credentials, or other secrets.
* Do not commit generated files or unnecessary ZIP archives.
* Do not introduce unnecessary dependencies.

### 5. Commit Your Changes

Use a clear commit message describing what you changed.

Examples:

```text
Add usage history display
```

```text
Fix usage calculation on Claude responses
```

```text
Improve extension settings UI
```

### 6. Push Your Branch

```bash
git push origin feature/my-feature
```

### 7. Open a Pull Request

Open a Pull Request against the project's default branch.

Please explain:

* What you changed
* Why you changed it
* How you tested it
* Any limitations or known issues

Use the Pull Request template provided by this repository.

## Reporting Bugs

Before opening a bug report:

1. Search existing issues.
2. Make sure you are using the latest version.
3. Check whether the issue can be reproduced consistently.

When reporting a bug, include:

* Operating system
* Browser or Claude Desktop environment
* Project version/commit
* Steps to reproduce
* Expected behavior
* Actual behavior
* Relevant console errors or logs

Do **not** include private conversations, authentication tokens, cookies, API keys, or other sensitive information.

## Feature Requests

Feature requests are welcome.

Please explain:

* What problem the feature would solve
* How you expect the feature to work
* Why it would be useful
* Any alternative solutions you considered

## Privacy

Claude Count Usage is designed with privacy in mind.

When submitting an issue or Pull Request, never include private Claude conversations, personal information, authentication credentials, API tokens, or other sensitive data.

## Code Style

Keep changes focused and consistent with the existing codebase.

Avoid unrelated formatting changes in the same Pull Request.

## Pull Request Checklist

Before submitting a Pull Request, make sure:

* [ ] The code works as expected.
* [ ] I tested my changes.
* [ ] I did not introduce unnecessary dependencies.
* [ ] I did not include secrets or credentials.
* [ ] I updated documentation where necessary.
* [ ] I checked for existing issues or Pull Requests.
* [ ] My Pull Request has a clear description.

Thank you for helping improve Claude Count Usage!
