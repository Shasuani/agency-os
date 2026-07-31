# brain/ — what the agents know about your business

Eight text files. The follow-up agent reads **all** of them before writing a
single message, and it is not allowed to state anything that is not in here or
in the contact's own history. That rule is what stops it inventing a price.

So this directory is the product. The code is scaffolding around it.

## How to use it

Edit the files. Plain text or Markdown, write like you talk. Then:

    pnpm seed              # dry run — prints what would be written
    pnpm seed --commit     # writes to the brain table

Re-run it whenever you change something. It overwrites by key, so editing a file
and re-running is the whole workflow.

## What "good" looks like

Not marketing copy. The agent is not writing an advert — it is writing a short,
plain follow-up to someone who has already met you. What it needs is **facts it
can safely state** and **the sound of your voice**.

Two tests before you leave a file:

1. **Could the agent state this to a customer and be right?** If a number or a
   claim is approximate, say so in the file, or leave it out. An agent that
   guesses your price in writing is worse than one that says nothing.
2. **Does it sound like you?** Read `tone_of_voice_el` out loud. If it does not
   sound like something you would say to a taverna owner you met last week, the
   drafts will not either.

## A file left empty is not a failure

An empty `case_studies` is honest and the agent handles it — it simply will not
reference past work. An **invented** case study is a lie you will have to defend
in a real conversation. Leave it blank until you have one you would happily
name.
