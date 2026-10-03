# The line profile for {{project.name}}

The line reads the repository's own answers from `.codecast/line.toml`: the
commands that check, prove, evaluate and ship a change, the cards cap, the
principles files and the declared finders. Without one the line runs on
defaults and the finder check has nothing to check.

Run `cast line profile` in {{project.dir}}.

When a profile exists, read it. Its project should be {{project.name}}; when it
names another project, or declares no finders, tell the person what you found
and propose the change rather than editing the file.

When the repository has none, show the person the starter that
`cast line profile --starter --project "{{project.name}}"` prints: the
defaults written out with this project filled in, and comments for the
commands and finders only they can name. Offer to write it. Write it with
`--write` only after they say yes, and leave committing it to them; it is a
tracked file in their repository.

Once a profile resolves with this project, run `cast line profile --publish`
so /line can show each finder. Then record the evidence check `profile` with
`cast org template evidence {{instance}} profile --status pass --source <what
shows it>` and mark this step done with `cast org template setup {{instance}}
line-profile --done --evidence <the same>`, both from {{project.dir}}.
