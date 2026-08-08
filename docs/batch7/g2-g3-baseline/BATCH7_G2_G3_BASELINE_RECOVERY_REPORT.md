# Batch7 G2/G3 Baseline — Recovery Report

## 1. Recovery objective

Establish a Git-native, non-self-referential content baseline for the four
Batch7 G2/G3 core materials, sourced from real loose files (not from a
prior commit, since no such commit could be found), on the real project
repository, with independently verifiable persistence.

## 2. Starting environment

- Real repository: `/home/ubuntu/eth-trading-dashboard`
- `origin`: `git@github.com:f2523794876-bot/eth-alpha-trading-system.git`
- Branch at start: `main` @ `e493abbe0720a7cdf7e268b1c95b8587302ddc79`
- Working tree at start: clean (`git status --porcelain=v1` empty)
- All work for this recovery was done in an isolated `git worktree` on a
  new branch; `main` and its checkout were never touched.

## 3. Search scope for c0e470d

Checked for `c0e470dbbd477aaf84510a44ea9eb20e6bcce18e` as a Git object in:

- 4 local repositories (`/home/ubuntu/pr24-review/eth-alpha-trading-system`,
  `/home/ubuntu/eth-trading-dashboard`,
  `/home/ubuntu/v14d-research/eth-alpha-trading-system`,
  `/home/ubuntu/v14d-audit/eth-alpha-trading-system`) via `git cat-file -t`
- 9 `.bundle` files found on the filesystem, imported into a scratch repo
  and checked via `git cat-file -t` and `git rev-list --all | grep`
- The real repository's full `git rev-list --all` and reflogs

## 4. c0e470d — not found

No object with this SHA exists in any of the above. It is recorded as:

`PREVIOUSLY_REPORTED_BUT_NOT_FOUND_AND_NOT_ACCEPTED_AS_A_GIT_OBJECT`

It is not asserted to have ever existed. This recovery does not use it as a
source of any material, does not derive any file from it, and does not
treat any prior claim about its contents as fact.

## 5. Trusted base — real object verification

`239302eb48311882ea2f3fa2a4bd227b2b767b64` was independently confirmed
present, with identical content, as the tip of
`refs/heads/claude/r3-batch7-p0-p1-scoped-fix` across six separate bundle
files. It is a real, substantive commit — a concurrency bug fix to
`server/src/validation-replay/research-run-status.js` and its test file —
consistent with genuine project history, not a fabricated placeholder.

Bundle used to import it into the real repository:

- Path: `/tmp/claude-1000/-home-ubuntu/c8d9e2d8-889a-4af7-97cf-808bd5f72f6e/scratchpad/frozen-test-evidence/r3-batch7-finalize-no-undo-fix-complete-history.bundle`
- Bytes: 2256822
- SHA-256: `9c0371a675c726194016845d5bfde687f374a91d5ebcacfaacc8706df8b7339e`
- `git bundle verify`: OK — "The bundle records a complete history."
- `git ls-remote`: `239302eb48311882ea2f3fa2a4bd227b2b767b64 refs/heads/claude/r3-batch7-p0-p1-scoped-fix`

Note on the six bundles: they are six verifiable carriers of the same
object, not six independently-generated sources — no evidence was found
that they arose from independent generation processes, so they are not
described as independent corroboration, only as repeated confirmation of
one object's presence and content.

## 6. Source files — discovery and metadata

All four core materials were found only as loose files (not in any Git
commit) in a prior, now-inaccessible session's scratchpad:

`/tmp/claude-1000/-home-ubuntu/c8d9e2d8-889a-4af7-97cf-808bd5f72f6e/scratchpad/frozen-test-evidence/`

| File | Bytes | Lines | Regular file | Symlink |
|---|---|---|---|---|
| r3-batch7-postgres-authority-DESIGN-REPORT.md | 109752 | 556 | yes | no |
| BATCH7_EXECUTION_AUTHORITY_DESIGN_FINAL_CORRECTIONS.md | 56872 | 522 | yes | no |
| BATCH7_ARTIFACT_PUBLICATION_PROTOCOL_SINGLE_ISSUE_CORRECTION.md | 37836 | 422 | yes | no |
| BATCH7_G2_G3_DE_NOVO_FINAL_REVIEW.md | 27340 | 208 | yes | no |

## 7. Source file SHA-256 (direct, computed against the actual files)

| File | SHA-256 |
|---|---|
| r3-batch7-postgres-authority-DESIGN-REPORT.md | 926ae6463af3ebfdbce1d7ea642fb17b9bf191aa7d5384a08f5867fbb948afab |
| BATCH7_EXECUTION_AUTHORITY_DESIGN_FINAL_CORRECTIONS.md | a1c526ddd87bc5053f4f8780183f1a2792ec0b1be43c8e0d670fa3d23c99b56d |
| BATCH7_ARTIFACT_PUBLICATION_PROTOCOL_SINGLE_ISSUE_CORRECTION.md | 1d9487dcbdf511c71f243757c4f1838a8ca072bfeb08a8f24a930dfc79dfd24d |
| BATCH7_G2_G3_DE_NOVO_FINAL_REVIEW.md | a725124fefcedc04a7e3fd438653f242db8c5ffb1c50c66f2431eca3a932101a |

All four match the expected SHA-256 values given for this recovery exactly.

## 8. Fixed working-copy SHA-256 (stage 2 of 3)

Copied byte-for-byte into
`/tmp/claude-1000/-home-ubuntu/1a30675f-f02f-46d5-80ea-337f6032893a/scratchpad/batch7-fixed-source-copy/`;
recomputed SHA-256 for every file — identical to section 7.

## 9. Committed-blob SHA-256 (stage 3 of 3)

Recomputed by reading each file back out of `CONTENT_BASELINE_COMMIT`'s
tree via `git show <commit>:<path> | sha256sum` — identical to sections 7
and 8 for all four files. Three-stage chain of custody is unbroken.

## 10. Why this is not a chat-summary reconstruction

No content was authored, rewritten, or filled in from this conversation's
summary of what the files were supposed to contain. Every byte committed
was read directly from the real loose files on disk and hash-verified
before, during, and after copying. The only newly-authored text in this
recovery is this report and the manifest — neither is one of the four core
materials, and neither is claimed to be.

## 11. Why c0e470d is not claimed to exist

Section 3 and 4 above are the complete basis: an exhaustive search across
every repository, bundle, and reflog accessible from this machine found no
object with that SHA. Absence of evidence was treated as grounds to not
assert existence, not as grounds to fabricate a substitute.

## 12. Branch

`claude/batch7-g2-g3-recovered-verified-baseline` (no naming collision
found locally or on `origin` — the preferred name was used as-is).

## 13. CONTENT_BASELINE_COMMIT

- SHA: `7f6736344cde5bf3290a0e8e3bd80d6736f66cb9`
- Parent: `239302eb48311882ea2f3fa2a4bd227b2b767b64`
- Tree: `f4ac8ac4d60d70bd9cf8cf7b27d61d187d0e131d`

## 14. CONTENT_BASELINE_COMMIT file range

```
A	docs/batch7/g2-g3-baseline/BATCH7_ARTIFACT_PUBLICATION_PROTOCOL_SINGLE_ISSUE_CORRECTION.md
A	docs/batch7/g2-g3-baseline/BATCH7_EXECUTION_AUTHORITY_DESIGN_FINAL_CORRECTIONS.md
A	docs/batch7/g2-g3-baseline/BATCH7_G2_G3_BASELINE_MANIFEST.md
A	docs/batch7/g2-g3-baseline/BATCH7_G2_G3_DE_NOVO_FINAL_REVIEW.md
A	docs/batch7/g2-g3-baseline/r3-batch7-postgres-authority-DESIGN-REPORT.md
```

## 15. Blob SHAs (CONTENT_BASELINE_COMMIT)

| File | Blob SHA |
|---|---|
| BATCH7_ARTIFACT_PUBLICATION_PROTOCOL_SINGLE_ISSUE_CORRECTION.md | bc1354e92a5d27af9ad55ac4686e69d63bea47d1 |
| BATCH7_EXECUTION_AUTHORITY_DESIGN_FINAL_CORRECTIONS.md | 1774be9d9018a07ed650c9ee8476cfa3715c0185 |
| BATCH7_G2_G3_BASELINE_MANIFEST.md | 8be2f5a38e6e9be7aef502f483c3502fdb01ebf5 |
| BATCH7_G2_G3_DE_NOVO_FINAL_REVIEW.md | 039b3a4b41d45fa5e0d31b436d0488e0a6702312 |
| r3-batch7-postgres-authority-DESIGN-REPORT.md | e14f331d4a4c07fa8e6ac1f99ded2c4ca6d9e7d4 |

## 16. Manifest SHA-256

`d1070c79f23845276d930fac8b6cd253217d6a09d504ef810a4c938dcc7e30f0`

## 17. Scope of this recovery

No production code, tests, database schema, migrations, or frozen
contracts were modified. Only `docs/batch7/g2-g3-baseline/` was touched,
across exactly two commits (this one's parent and this one).

## 18. 180-day research

Not started. Not authorized by this recovery.

## 19. Implementation authorization

`NOT_GRANTED_BY_THIS_RECOVERY`.

## 20. Push and bundle persistence

Recorded in the terminal reply following this commit, since the push and
bundle both depend on this commit and the attestation commit existing
first. Not predicted here.

## 21. Current project status

- G2/G3 de novo review: `DE_NOVO_G2_G3_DESIGN_APPROVED` (per the recovered
  `BATCH7_G2_G3_DE_NOVO_FINAL_REVIEW.md`, now committed at the path above)
- G1: not reviewed in this cycle
- Production code for this batch: not started
- No code implementation task is created or implied by this recovery

## 22. Final conclusion

`BATCH7_G2_G3_VERIFIED_SOURCE_RECOVERY_ESTABLISHED`

Persistence status is reported independently, after this commit, in the
terminal reply — it is not predicted or asserted here.

## 23. Note on this commit's own SHA

This report does not and cannot state the SHA of the commit it is about to
become part of (`ATTESTATION_COMMIT`). That SHA is reported only after the
commit is made, in the terminal reply.
