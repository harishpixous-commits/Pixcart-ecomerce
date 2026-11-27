# Prompt to continue the work in another AI agent (strict)

Paste the whole block below into the new agent (for example Instinct) when the previous agent has stopped.

```
You are continuing the PixCart project exactly where the previous agent stopped. PixCart is an Indian multi-seller
marketplace built twice and kept EQUAL: (1) the Python/FastAPI + Next.js version and (2) the company version in
ASP.NET Core .NET 10 + MySQL 8.4 + Angular + Flutter. Nothing done so far may be lost, redone or broken.

YOUR MANDATE — NON-STOP, COMPLETE, VERIFIED:
- Work continuously, step after step, until EVERY item in section 7 of CONTINUE_HERE.md is finished, verified and
  shipped. Do not stop after one step, do not wait for applause, do not end your turn with a plan instead of work.
- Do not ask the owner questions you can answer yourself from the files, the code or sensible defaults. Only stop for a
  decision that truly belongs to the owner (money, a live deployment, deleting data, something irreversible); even then,
  write the question into section 6 of CONTINUE_HERE.md and keep working on the other items meanwhile.
- Every feature, module, improvement or fix must be made in BOTH versions and keep them equal (same behaviour, same
  messages, same JSON, same rules). A change in only one version is not done.
- The owner's quality bar: every module gets every useful option and setting, at the most advanced level (nothing more
  could sensibly be added), user friendly, and working well. Think like each user (shopper, seller, delivery partner,
  support agent, admin owner) in real daily use in India.
- "Done" means: built in both versions, tests written and passing, the whole test suites passing, the browser checks
  passing, committed, pushed, and section 6 of CONTINUE_HERE.md updated. Never claim something works without running it.

FIRST, before any change (in this order):
1. Read C:\Users\haris\Downloads\PixCart-company\docs\CONTINUE_HERE.md completely (rules, repositories, worktrees,
   local services, the state of every workstream, commands). Sections 6.6 to 6.10 and section 7 are the current work.
2. Run `git status` and `git log --oneline -15` in C:\Users\haris\Downloads\PixCart-company (branch port/company),
   C:\Users\haris\Downloads\PixCart-company-payments (branch feature/payments) and
   C:\Users\haris\Downloads\PixCart-python-dev (branch feature/advanced), so you know exactly what changed since the
   file was written. Commit or finish anything left uncommitted before starting new work.
3. Check the local services the file lists (MySQL on 3307, PostgreSQL on 5433, the Razorpay simulator on 8790).

THE WORK LOOP (repeat until section 7 is empty):
a. Take the next item of section 7. Read the code it touches in BOTH versions before writing anything.
b. Build it in both versions, small and clean, following each codebase's existing style.
c. Write tests for it in both versions (pytest for Python, xUnit for .NET), run the related tests, then the WHOLE
   suites: `bash /c/Users/haris/pixcart-tools/pytest-dev.sh -q -p no:cacheprovider` (Python) and
   `cd PixCartAPI && dotnet build PixCartAPI.sln -nologo -v q && dotnet test Tests/Tests.csproj --no-build -nologo` (.NET,
   0 warnings required). Never run two .NET test runs at once (they share the MySQL test database).
d. For company-version changes that reach users: publish the package
   (`tools/publish-windows.ps1 -Output C:\Users\haris\pixcart-tools\e2e-site`), run it (tools/handover-kit/run-e2e-site.ps1),
   then run the browser suite (45 journeys), both panel crawls and the cross-role order flow (commands in sections 6.6b,
   6.6c and 8 of CONTINUE_HERE.md).
e. Commit as: git -c user.name=PixCart-Dev -c user.email=dev@pixcart.local commit -m "<plain description>"
   (small commits; never a Co-Authored-By line or any AI/tool name; never anyone's email address in a command).
f. Push port/company and feature/payments to the personal repo: `git push origin <branch>`.
g. Ship verified company-version work ONLY with
   `bash tools/company-export/update_company.sh web "<subject>" "<body>"` (unset MSYS_NO_PATHCONV first). It builds, runs
   every test and pushes only when all pass. Mobile: `... mobile ...`.
h. Update section 6 of CONTINUE_HERE.md (what is done, what is next, exact commands), commit and push it.
i. Go back to a. without stopping.

RULES YOU MUST NEVER BREAK:
- Never edit, merge into or push the Python `main` branch, never deploy anything, and never push the Python branch
  feature/advanced (pushed branches may build preview deployments on Vercel). Keep it committed locally.
- Never change the company demo database package `db/` (test sign-ins, data and private images stay byte-identical to
  the first delivery, company commit 316b17f). Test-only data changes go into the local copy pixcart_e2e only.
- The company repositories (PixoustechIndia-org/Pix-ShopCart_Web and Pix-ShopCart_Mobile) must never show AI help or
  that code came from the other version: no AI names, no "Python", "ported", "migrated", "reference", ".py" in their
  code or comments; ship to them only with update_company.sh.
- The package's web.config keeps App__Environment=production and App__ExternalProviderMode=open.
- No live payment, SMS or other paid provider calls in development or tests (use the fakes and simulators). No secrets
  in code, commits or chat; the parity admin password stays in C:\Users\haris\pixcart-tools\parity-admin-password.txt
  and is never printed.
- Never delete files or data you did not create in this session. Stop only processes you started (by PID or port).
- Only correct, verified code goes to any GitHub repository.

PROTECT THE WORK AGAINST USAGE LIMITS:
- Commit and push after every finished piece (not only at the end), and update section 6 of CONTINUE_HERE.md at least
  after every step, so the next agent can continue from the exact point you reached.
- When you sense you are close to your limit: stop starting new work, commit and push everything, and write the exact
  next step (file, function, command) into sections 6 and 7.

Start now with step 1 of FIRST, then work through section 7 without stopping.
```
