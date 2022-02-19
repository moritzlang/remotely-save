# Sync Algorithm V2

## Sources

We have 4 record sources:

1. Local files. By scanning all files in the vault locally. Actually Obsidian provides an api directly returning this.
2. Remote files. By scanning all files on the remote service. Some services provide an api directly returning this, and some other services require the plugin scanning the folders recursively.
3. Local "delete-or-rename" history. It's recorded by using Obsidian's tracking api. So if users delete or rename files/folders outside Obsidian, we could do nothing.
4. Remote "delete" history. It's uploaded by the plugin in each sync.

Assuming all sources are reliable.

## Deal with them

We list all combinations mutually exclusive and collectively exhaustive.

### Files


| t1             | t2             | t3             | t4             | local file to do | remote file to do | local del history to do | remote del history to do | equal to sync v2 branch |
| -------------- | -------------- | -------------- | -------------- | ---------------- | ----------------- | ----------------------- | ------------------------ | ----------------------- |
| mtime_local    | mtime_remote   | deltime_local  | deltime_remote | del              | del               | clean                   | skip                     |                         |
| mtime_local    | mtime_remote   | deltime_remote | deltime_local  | del              | del               | clean                   | skip                     |                         |
| mtime_local    | deltime_local  | mtime_remote   | deltime_remote | del              | del               | clean                   | skip                     |                         |
| mtime_local    | deltime_local  | deltime_remote | mtime_remote   | download_remote  | skip              | clean                   | clean                    |                         |
| mtime_local    | deltime_remote | mtime_remote   | deltime_local  | del              | del               | clean                   | upload_local_del_history |                         |
| mtime_local    | deltime_remote | deltime_local  | mtime_remote   | download_remote  | skip              | clean                   | clean                    |                         |
| mtime_remote   | mtime_local    | deltime_local  | deltime_remote | del              | del               | clean                   | skip                     |                         |
| mtime_remote   | mtime_local    | deltime_remote | deltime_local  | del              | del               | clean                   | upload_local_del_history |                         |
| mtime_remote   | deltime_local  | mtime_local    | deltime_remote | del              | del               | clean                   | skip                     |                         |
| mtime_remote   | deltime_local  | deltime_remote | mtime_local    | skip             | upload_local      | clean                   | clean                    |                         |
| mtime_remote   | deltime_remote | mtime_local    | deltime_local  | del              | del               | clean                   | upload_local_del_history |                         |
| mtime_remote   | deltime_remote | deltime_local  | mtime_local    | skip             | upload_local      | clean                   | clean                    |                         |
| deltime_local  | mtime_local    | mtime_remote   | deltime_remote | del              | del               | clean                   | skip                     |                         |
| deltime_local  | mtime_local    | deltime_remote | mtime_remote   | download_remote  | skip              | clean                   | clean                    |                         |
| deltime_local  | mtime_remote   | mtime_local    | deltime_remote | del              | del               | clean                   | skip                     |                         |
| deltime_local  | mtime_remote   | deltime_remote | mtime_local    | skip             | upload_local      | clean                   | clean                    |                         |
| deltime_local  | deltime_remote | mtime_local    | mtime_remote   | download_remote  | skip              | clean                   | clean                    |                         |
| deltime_local  | deltime_remote | mtime_remote   | mtime_local    | skip             | upload_local      | clean                   | clean                    |                         |
| deltime_remote | mtime_local    | mtime_remote   | deltime_local  | skip             | del               | clean                   | upload_local_del_history | 8                       |
| deltime_remote | mtime_local    | deltime_local  | mtime_remote   | download_remote  | skip              | clean                   | clean                    | 7;9                     |
| deltime_remote | mtime_remote   | mtime_local    | deltime_local  | del              | del               | clean                   | upload_local_del_history |                         |
| deltime_remote | mtime_remote   | deltime_local  | mtime_local    | skip             | upload_local      | clean                   | clean                    | 10                      |
| deltime_remote | deltime_local  | mtime_local    | mtime_remote   | download_remote  | skip              | clean                   | clean                    | 1;9                     |
| deltime_remote | deltime_local  | mtime_remote   | mtime_local    | skip             | upload_local      | clean                   | clean                    | 2;3;4;5;6               |

### Folders

We actually do not use any folders' metadata. Thus the only relevent info is their names, while the mtime is actually ignorable.

1. Firstly generate all the files' plan. If any files exist, then it's parent folders all should exist. If the should-exist folder doesn't exist locally, the local should create it recursively. If the should-exist folder doesn't exist remotely, the remote should create it recursively.
2. Secondly a folder is deletable, **if and only if**: all its sub-folders are deletable (a.k.a. marked being deleted before the mtime), **and** all sub-files are deletable (a.k.a. marked being deleted before the mtime). 
