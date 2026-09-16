# pg-backup on the host

Deploy: copy `infra/pg-backup` to `/srv/pg-backup/build`, build it as
`codecast/pg-backup`, write `/srv/pg-backup/.env`, install the two units
into `/etc/systemd/system`, then `systemctl enable --now pg-backup.timer`.
`systemctl start pg-backup.service` takes a dump immediately;
`journalctl -u pg-backup` shows the run. Dumps land in R2 under
`backups/pg-codecast-<date>.dump`, rotated after 14 days by the script.
