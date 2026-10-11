# Railway infrastructure as code

`railway.ts` is the whole of this project's Railway configuration: the Postgres
database, the game service, its GitHub source, its build and start commands, and
its health check. Edit it here rather than the dashboard — the dashboard is where
configuration goes to be overwritten by the next `railway config apply`.

Plan a change, then apply it:

```bash
railway config plan
railway config apply --yes
```

Secrets are not in this file. `SESSION_SECRET` and `NODE_ENV` are `preserve()`d:
they stay whatever is already set on the service, so rotating the session cookie
is a dashboard operation and never a commit.

## Windows

`railway config plan` fails on Windows with a message claiming the CLI is too old
(it is not — 5.57.11 passes the 5.42.1 floor comfortably). The `railway/iac`
package shells out to `process.env._` to read the CLI version, and on Windows
that variable is unset, so it falls back to `railway` — which Node cannot spawn,
because Node refuses to execute a `.cmd` without a shell.

Point it at the real executable instead:

```powershell
$env:_="$env:APPDATA\npm\node_modules\@railway\cli\bin\railway.exe"
```

or, wherever nvm put it:

```powershell
$env:_="C:\nvm4w\nodejs\node_modules\@railway\cli\bin\railway.exe"
railway config plan
```

This is a packaging bug in the SDK, not a misconfiguration. `node --version`
does not work as a substitute: it prints `v24.19.0`, which the SDK's regex
cannot match, so it fails the version check for a different reason.

A second Windows-only trap, in the CLI rather than the SDK: `railway config
migrate` derives the service name from the directory ("Where's Waldo") instead of
the service's actual name ("wheres-waldo"). Taking its output verbatim produces a
plan that **creates a second service and destroys the live one**. The file here
was hand-written for that reason — check any migrated service name against the
dashboard before applying.