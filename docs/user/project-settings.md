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
