# Customize a project icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

# Let an agent manage projects

Agents running through T3 Code can list and inspect projects in their current environment. They can
also register an existing directory, create a missing directory, clone and register a repository,
or update the same project settings available in the app.

Removing a project does not remove its directory, repository, worktrees, or other workspace files.
If the project still has threads, the agent must explicitly request that T3 Code delete those thread
records first. This prevents a project removal from silently discarding conversations.

# Start a thread in another project

An agent can start an ordinary top-level conversation in any project registered in the same T3
Code environment. It can use the project root, an existing worktree, or ask T3 Code to create a new
worktree. If it selects another project without choosing a workspace, T3 Code uses that project's
root and does not reuse the calling thread's checkout.

Choosing an existing worktree does not switch its branch. T3 Code verifies that the path is a real
worktree of the selected project's repository, resolves symlinks to the canonical checkout, and
rejects a requested branch when the checkout is currently on a different branch.

The new thread keeps the calling agent's provider, model, runtime mode, and interaction mode unless
the request supplies a narrower supported override. Selecting a project does not grant broader
permissions. Agents can also list, read, message, wait for, and interrupt threads in that selected
project; leaving the project unspecified keeps the current project as the default.
