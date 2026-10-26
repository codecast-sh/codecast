# Deploying Codecast with an MDM

This guide is for the IT admin who manages your team's Macs. You upload two files to your MDM: an installer and a configuration profile. Every Mac in scope then gets the Codecast app and the `cast` command line tool. Each person who logs in is enrolled in your team and has their session sync running, with no terminal step.

Works with any MDM that can deploy a signed installer package and a custom configuration profile. Jamf Pro, Kandji, Microsoft Intune and Mosyle are covered below.

## Requirements

- Macs with Apple silicon (M1 or later), macOS 13 or later. The installer refuses Intel Macs.
- A Codecast team, and an admin of that team to download the profile.

## The two files

| File | Where to get it | What it does |
|---|---|---|
| `Codecast.pkg` | Team settings > Managed devices | Installs the app and the command line tool for the whole Mac |
| `Codecast.mobileconfig` | Team settings > Managed devices > Download profile | Tells each Mac which team to join and which features your organization allows |

### What the installer puts on the Mac

| Path | What it is |
|---|---|
| `/Applications/Codecast.app` | The desktop app |
| `/usr/local/bin/codecast`, `/usr/local/bin/cast` | The command line tool and its short name |
| `/Library/LaunchAgents/sh.codecast.enroll.plist` | Runs `codecast mdm enroll` for each person at login |

At login, the enroll agent reads the profile, joins the Mac to your team, opens the browser once so the person can sign in, and starts the background service that syncs their agent sessions. It runs again whenever the profile arrives or changes, so the order in which your MDM delivers the profile and the installer doesn't matter. If someone is logged in during the install, enrollment starts right away without a logout.

Its log is at `~/.codecast/mdm-enroll.log` in each person's home folder.

Reinstalling the same or a newer package is safe. If a person had already installed `cast` themselves, their copy is replaced by a link to the one in `/usr/local/bin`, so the Mac never runs two copies.

### Updates

The command line tool installed by the package doesn't update itself. To roll out a new version, upload a newer `Codecast.pkg` to your MDM. `cast mdm status` on a Mac shows the installed version.

## The configuration profile

Download it from **Team settings > Managed devices**. It already contains your team's enrollment token and server addresses, plus the restrictions you picked on that page. Upload it to your MDM as a custom configuration profile, scoped to the same Macs as the installer.

The settings live in the preference domain `sh.codecast`. If you prefer to write the profile yourself, these are the keys:

| Key | Type | What it does |
|---|---|---|
| `EnrollmentToken` | string | Joins the Mac to your team. Required for enrollment. |
| `UserEmail` | string | The person this Mac belongs to. Their sign-in must match it. Use your MDM's email variable (below). |
| `WebURL` | string | The Codecast web address. Only for a self-hosted Codecast. |
| `ServerURL` | string | The Codecast server address. Only for a self-hosted Codecast. |
| `PublicSharingDisabled` | boolean | No published pages and no public share links. |
| `BrowserControlDisabled` | boolean | Agents can't drive a web browser. |
| `ComputerControlDisabled` | boolean | Agents can't drive desktop apps. |
| `CloudHostsDisabled` | boolean | No cloud hosts: agents run only on the Mac itself. |
| `AutoUpdate` | boolean | Forces the app's own updates on (true) or off (false). Leave it out to let each person choose. |
| `ExcludedPaths` | array of strings | Folders whose sessions never leave the Mac. `~` means each person's home folder. |

Restrictions set here combine with the ones a team admin sets in Team settings. If either side turns a feature off, it stays off, and folders excluded on either side are all excluded.

### Filling in each person's email

Replace the `UserEmail` value with your MDM's variable for the assigned user's email. Your MDM fills it in per Mac before installing the profile.

| MDM | Variable | Notes |
|---|---|---|
| Jamf Pro | `$EMAIL` | Taken from the computer's User and Location record. Case sensitive. |
| Kandji | `$EMAIL` | The email of the device's assigned user. |
| Microsoft Intune | `{{mail}}` | Resolves only on Macs enrolled with user affinity. Case sensitive. |
| Mosyle | `%Email%` | Resolves only on Macs with an assigned user. Leave "Enable variables for this profile" turned on when you upload. |

If a Mac has no assigned user, leave `UserEmail` out. The person can then sign in with any account, and enrollment still joins the Mac to your team.

## Permissions people still grant themselves

The profile can pre-approve Accessibility for Codecast, which agents need to drive desktop apps. macOS doesn't let any profile pre-approve Screen Recording. The first time an agent needs to see the screen, macOS asks the person to allow it in System Settings > Privacy & Security > Screen & System Audio Recording. If you set `ComputerControlDisabled`, nobody is asked.

## Checking a Mac

On a managed Mac, open Terminal and run:

```
cast mdm status
```

It shows whether the profile is installed, which team the Mac is enrolled in, who is signed in, whether the background service is running, and which settings your organization manages. The same Macs appear under **Team settings > Managed devices**.

If a Mac isn't enrolling, check `~/.codecast/mdm-enroll.log` in the person's home folder, and confirm the profile shows under System Settings > General > Device Management.
