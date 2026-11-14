# Machines

The Machines page shows every computer you run T3 Code on, side by side. Use it to link them, bring a
Claude session from one machine to another, copy uncommitted work between checkouts, move threads,
and compare Claude Code setups.

Open it with the Machines icon in the sidebar, or run "Open machines" from the command palette.

## Link machines

Machines can only work with each other once they are linked. Turn on Linked environments on each
machine (the Machines list shows "Links off" with a "Turn on" button), select two or more machines,
and choose "Link selected both ways". Both machines must have links on.

## Update machines

Machines never update on their own. A machine that can move to a newer release shows "Update to"
with the version. Choose "Update machines…" to pick which ones to update; they restart one at a
time, with this computer last. A machine with running threads is left unticked, because restarting
its server stops them. A machine that cannot update from here, such as one run from source, says
why.

## Repositories

The same repository on several machines appears as one row. Expand a row to see its checkouts and
Claude sessions on each machine.

- **Bring a session here.** Pick a Claude session from another machine and bring it to this one. The
  session continues with its full context.
- **Import a session on the same machine.** A checkout lists the Claude sessions on its machine that
  are not threads yet. Expand the list and choose "Import" to open one as a thread in that project, on
  any connected machine. Sessions started in another folder or worktree are copied into the project
  first; the original stays where it was. The list covers the last 14 days; tick "Sessions from the
  last 90 days" to see older ones.
- **Copy uncommitted work.** Select two checkouts; the first is the source and the second the
  destination. T3 Code applies the changes only when both checkouts are on the same commit and the
  destination has no conflicting edits. Otherwise the work is kept as git refs and nothing is
  overwritten.
- **Undo.** After a transfer, "Undo" restores the working tree it changed.

## Move a thread

Choose "Move to machine…" on a thread, or "Move threads off…" on a machine to move all its threads.
The agent keeps its full context. The thread's visible history comes along as text only.

These do not come along:

- Tool cards, diffs, checkpoints, and images.
- Tags, pins, pull request links, queued messages, scheduled tasks, and child threads.

Only Claude threads can move. Stop a running thread first.

## Config

The Config section compares your Claude Code setup between machines so you can see what differs. It is
read-only. Secret values are never read or shown.

## Assistant

The Assistant button opens a "Machines" project whose agent studies your machines and proposes a plan.
Each step appears in a card, and nothing runs until you approve that step. Ask it to copy config
between machines, which the Config section cannot do on its own.
