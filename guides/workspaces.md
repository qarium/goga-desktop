# Working with projects, topics, and runs

A project is a local folder. In **No topic**, Desktop works in that original folder. A topic lets you work in a separate Git working copy. Before editing, launching, or transferring commits, check the project and topic in the header. If Desktop offers more than one working copy for the topic, select the one you intend to use.

## Find and organize topics

Use the **Topics** tab to filter the table or board by year and search for a topic. Both views use the same list, which loads when you select the project. Desktop refreshes the selected project and year in the background; refresh pauses on Home and when the window is hidden. Use **Refresh list** when you need the latest state immediately. Topic operations require a Git repository.

## Move work between a topic and the original project

First commit the changes you want to transfer. An edited or saved file that has not been committed does not travel with a commit sync. The header acts on the selected topic; the topic card also offers local actions. Choose the operation by its destination:

| What you want | Action and effect |
| --- | --- |
| Exchange commits on the same topic branch | **Sync topic** in the header first brings commits from the original project's topic branch into the working copy, then sends the result back to the original project. This does not publish to a remote server or merge the topic into the base. |
| Send the working copy's commits to the original project only | **Sync**, under **Transfer changes** in the topic card, sends commits from the copy to its branch in the original local project. It does not merge them into a different branch. |
| Apply the topic locally | **Apply to base…** in the topic card previews the target branch and affected files. Confirm to apply to the current branch of the original folder. Desktop does not switch that branch for this action; local changes, conflicts, or another operation can block it. |
| Bring changes from the base into a topic | **Update from base** uses the original project's base, checking its upstream if the branch is published, and updates the topic working copy. |
| Publish the topic branch | **Publish topic** sends committed changes from the working copy through the original project to its remote. |
| Merge the topic into the base and publish the base | **Transfer topic to base and publish** synchronizes the copy, runs Goga's propagation operation, and publishes the base. Unlike local apply, this may temporarily switch the original project's branch. Check the target before confirming. |

With **No topic** selected, the header's sync and publish actions target the original project's **current branch**, not a topic copy. A synced topic has not necessarily been applied to the base or published.

## Remove topics

Select the topics on the board or in the table, then choose **Delete selected topics**. Check the project, year, and list in the confirmation dialog. While the preview is being prepared you can close it or press Esc without deleting anything.

**Deletion is not just removing a card.** After Goga removes the topics and Desktop verifies the result, eligible working copies go to the system Trash **as whole folders**, including uncommitted, untracked, or ignored files and commits not transferred elsewhere. Preserve anything you need before confirming. If deletion cannot be confirmed, Desktop leaves the copies in place. Read the result to see which copies were kept.

**Clear topics** is a separate operation: Goga determines which topics to clear from the year and base branch, not from the current selection. Desktop checks the corresponding working copies separately and preserves copies with local data.

## Edit a project document

The **Project** tab provides editors for project configuration and Goga documents. Use the actions in the editor header to:

- **Rename** a workflow, pipeline, project profile, or tool YAML file without moving it to a different folder. Unsaved edits stay with the renamed file. Update references to the old name yourself.
- **Reload from disk** to read changes made in another editor. If you have a draft, Desktop asks before replacing it.
- **Expand document** to use the workspace for editing. Collapse it or press Esc to return without losing the selection or edit history.

When you leave **Overview** or **Project** with unsaved edits, Desktop asks whether to save them. Switching files inside the same section does not prompt. Before switching workspaces or preparing a launch, Desktop checks both editors in the current project and topic. **Continue without saving** keeps the drafts in Desktop; the pipeline reads the files on disk.

To save automatically on navigation, select **Don't ask again and save automatically**, then **Save and continue**. To restore the prompt, turn off **Autosave on navigation** under **Settings → General**. If the on-disk version conflicts with a draft, Desktop stops navigation rather than overwriting someone else's edits. Global settings and personal profiles still require an explicit action to open their contents.

## Connect to an already running pipeline

Open **Runs → Connect pipeline** in the project or topic where you want to see the dashboard. Paste the local HTTP address, including the port, from the pipeline's `dashboard:` line, for example `http://localhost:52456`. Do not include a path, query parameters, or credentials.

Desktop checks the dashboard response and run ID. If it can verify that the dashboard belongs to a known run, it opens the existing run tab. Otherwise, a valid external dashboard opens as a separate session-only viewer. Its title comes from `flow_name`, or `run_id` if no name is available. The selected project or topic determines where Desktop shows the viewer; it does not establish the external process's branch, profile, or topic. Closing this external tab disconnects the viewer; it does not stop the process.

Use **Reload dashboard**, F5, or ⌘R/Ctrl+R to reload a run's web panel without rebuilding or restarting its process. A build without a web panel still has its output log.

[Back to Goga Desktop](../README.md)
