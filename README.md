# Shift-V2: Real-Time Architectural Guidance Extension

Shift-V2 is a VS Code/Cursor extension that provides real-time, proactive guidance on architectural best practices. Unlike linters or reactive AI tools, Shift-V2 focuses on the big picture—analyzing your entire codebase to spot high-level design issues like N+1 queries or inefficient component usage. It delivers clear, actionable tips without you needing to ask.

## Features

- **Whole-Codebase Analysis:** Monitors your project and identifies architectural inefficiencies using OpenAI's O3-Mini model.
- **Automatic Tips:** Get alerts like "This might slow your database queries" as you save files.
- **Tailored Fixes:** Suggestions like "Fetch this data in one batch" that fit your code.
- **Clear Explanations:** Understand why it matters, e.g., "Multiple queries here can bottleneck your app."
- **Ask Questions:** Hit "Clarify" to dig deeper into any tip.

![Notification Example](images/notification-example.png)
*Example: A notification with a detected issue and option to see details.*

## Requirements

- **VS Code:** Version 1.96.0 or higher.
- **OpenAI API Key:** Required for the O3-Mini model. Get one from [OpenAI](https://platform.openai.com/).

## Extension Settings

Shift-V2 adds the following setting:

- `shift-v2.openaiApiKey`: Your OpenAI API key for accessing the O3-Mini model. Set it in VS Code Settings.

### How to Set Up

1. Install the extension via the VS Code Marketplace (once published) or by sideloading the `.vsix` file.
2. Open VS Code Settings (`Ctrl+,` or `Cmd+,` on Mac).
3. Search for `shift-v2.openaiApiKey` and paste your OpenAI API key.
4. Start coding—Shift-V2 will analyze your codebase on file saves.

## Known Issues

- Large codebases (>200k tokens) may exceed the O3-Mini context limit; future versions will address this.
- Initial cache loading might take a few seconds on big projects.

## Release Notes

### 0.0.1

- Initial release with core architectural analysis for database queries and component misuse.
- Proactive notifications and clarification feature included.

---

## Following Extension Guidelines

This extension adheres to [VS Code Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines).

## For More Information

- [VS Code Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
- [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy better architecture with Shift-V2!**
