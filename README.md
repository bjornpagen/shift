# Shift-V2: Real-Time Architectural Guidance Extension

Shift-V2 is a VS Code/Cursor extension that provides real-time, proactive guidance on architectural best practices. Unlike linters or reactive AI tools, Shift-V2 focuses on the big picture—analyzing your entire codebase to spot high-level design issues like N+1 queries or inefficient component usage. It delivers clear, actionable tips without you needing to ask.

## Features

- **Whole-Codebase Analysis:** Monitors your project and identifies architectural inefficiencies using OpenAI's O3-Mini model and a graph database for precise context.
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

1. **Install the Extension:** Install Shift-V2 from the VS Code Marketplace or sideload the `.vsix` file.
2. **Set API Key:**
   - Open VS Code Settings (`Ctrl+,` or `Cmd+,` on Mac).
   - Search for `shift-v2.openaiApiKey`.
   - Enter your OpenAI API key.
3. **Ensure Kùzu Integration:** The extension uses a Kùzu graph database for enhanced analysis. No additional setup is required if installed via the official release.

### How to Use

1. **Start Coding:** Open your project in VS Code. Shift-V2 automatically analyzes your codebase as you save files, leveraging the Kùzu database to examine code constructs (e.g., functions, classes) and their relationships (e.g., calls, data usage).
2. **View Notifications:** When an architectural issue is detected, a notification appears with a brief description (e.g., "N+1 query detected"). Click "See Details" for the full explanation and fix.
3. **Act on Suggestions:** Apply the suggested fix or click "Clarify" to ask the AI for more details.

#### Example
Suppose you write a function that fetches user data in a loop:

```javascript
1: async function getUserPosts(users) {
2:   const posts = [];
3:   for (const user of users) {
4:     posts.push(await db.query("SELECT * FROM posts WHERE user_id = ?", user.id));
5:   }
6:   return posts;
7: }
