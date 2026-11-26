# Prompt to continue the work in another AI agent

Paste the block below into the new agent (for example Instinct) when the previous agent has stopped.

```
You are continuing the PixCart rebuild (ASP.NET Core .NET 10 + MySQL 8.4 + Angular 21 + Flutter) exactly where the
previous agent stopped. The previous agent's limit ran out; nothing should be lost or redone.

Work on this machine. FIRST read, completely:
  C:\Users\haris\Downloads\PixCart-company\docs\CONTINUE_HERE.md
It has the rules you must never break, the repositories and worktrees, the local services and how to start them, the
state of every workstream, and the exact next steps with commands. Then run `git log --oneline -15` in
C:\Users\haris\Downloads\PixCart-company and in the page-group worktrees it lists, and read the group ledgers
(<worktree>\parity-out\status.json), so you know what changed since the file was written.

The most important rules (details in the file):
- Never change the live Python/Next.js version (branch main, folder "pixcart-marketplace"), never deploy.
- Commit only as: git -c user.name=PixCart-Dev -c user.email=dev@pixcart.local commit -m "..."
  Never add Co-Authored-By or any AI/tool name to commits. Never put anyone's email address in a command.
- The company repositories (PixoustechIndia-org/Pix-ShopCart_Web and Pix-ShopCart_Mobile) must never show AI help or
  that the code came from the Python version: ship to them ONLY with tools/company-export/update_company.sh.
- No secrets in code or chat; the demo admin password stays in C:\Users\haris\pixcart-tools\parity-admin-password.txt.
- Verify before you claim: pixel comparison against the reference site, clicking through, tests.

Continue with section 7 of CONTINUE_HERE.md ("Order of work from here"), step by step, until everything is complete.
After each step: commit, push the branch to the personal repo (origin), and update section 6 of CONTINUE_HERE.md.
```
