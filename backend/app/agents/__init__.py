"""AI agents: background workers that notice a job needs doing and write a proposal. Nothing runs until staff approve it
(Admin -> AI agents). Each agent works from real database queries with plain rules, so it needs no paid AI service.
Approving runs the same admin code the admin panel uses, so validation, notifications and the audit log are identical."""
