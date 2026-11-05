# Canvas Assignment Sync for Super Productivity

Get your Canvas assignments into [Super Productivity](https://super-productivity.com/)
automatically, with their due dates and a reminder before each one is due.

- Each **course** becomes a project.
- Each **assignment** becomes a task, with the Canvas due date as its deadline.
- You get a **reminder 3 days before** each deadline. You can change the number of days.
- New and changed assignments sync on their own every hour.

## What you need

- The **Super Productivity desktop app** (free, for Windows, Mac and Linux). The web
  and phone versions don't support this plugin.
- A **Canvas** account. You don't need an access token or any admin permission.

## Install

1. **Make your plugin:** go to the
   **[Canvas Plugin Maker](https://faisaltamanojr.github.io/canvas-superproductivity/)**,
   paste your Canvas Calendar Feed link, and click **Download plugin**.

   To find the link, open Canvas, click **Calendar**, then **Calendar Feed** (bottom
   right), and copy the link.
2. **Install it:** in Super Productivity, go to **Settings → Plugins**. Under
   **Install Plugin**, click **Choose Plugin File**, pick the file you downloaded, and confirm.
3. **Connect Canvas:** click **Canvas Assignment Sync** in the left menu, paste your
   Calendar Feed link, and click **Save link & sync**.

Your courses and assignments appear within a few seconds.

## Using it

- **When you finish an assignment**, tick it done in Super Productivity. Canvas doesn't
  share whether you've submitted something, so the plugin can't do this for you.
- **Your changes are kept.** The plugin never reopens, recreates or renames tasks you've
  finished, deleted or edited.
- **If a due date changes in Canvas**, the task's deadline and reminder move with it.
- **To stop syncing a course**, click **Pause** next to it on the plugin page.
- **At the end of the semester**, archive the course projects. Archived courses stop syncing.
- **To group your courses in a folder**, hover over **Projects** in the left sidebar,
  click the new-folder icon, and drag your courses into it.

## Good to know

- **Reminders only appear while Super Productivity is open.**
- **Assignments that are already past due** aren't imported. You can change this on the
  plugin page.
- **Assignments without a due date** aren't in Canvas's calendar feed, so they don't
  show up.
- **Keep your feed link private.** Anyone who has it can see your Canvas calendar. The
  plugin stores it only on your computer and leaves it out of Super Productivity's sync
  and backups. The Plugin Maker runs in your browser and doesn't send your link anywhere.
- **Each plugin file is made for one school.** If you change schools, make a new one.

## Troubleshooting

The plugin page shows the result of the last sync. If something's wrong:

| Message | What to do |
|---|---|
| "This plugin was made for … but your link is on …" | Make a new plugin with this exact feed link in the Plugin Maker, then install that one. |
| "Canvas did not return a calendar" | Copy the Calendar Feed link from Canvas again and save it. |
| "0 assignments in feed" | Check that you copied the **Calendar Feed** link, not the address of the Calendar page. |
| No reminders | Keep Super Productivity open, and check that reminders are on in its settings. |

Still stuck? [Open an issue](https://github.com/FaisalTamanoJr/canvas-superproductivity/issues).

## For developers

```sh
npm test                           # run the tests (Node 20 or newer, no dependencies)
node build.mjs site                # regenerate the Plugin Maker page (docs/index.html)
node build.mjs canvas.myschool.edu # build a single plugin zip into dist/
```

The plugin source is in `plugin/`. Run `node build.mjs site` after changing it, so the
Plugin Maker page includes the new version.

## License

[MIT](LICENSE)
