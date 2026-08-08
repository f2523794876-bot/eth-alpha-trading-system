# Batch7 G2/G3 Baseline Manifest

## 1. Nature of this baseline

This is a **content baseline recovered directly from four real loose source
files**, not from any prior Git commit. No such commit was ever located.

## 2. Prior existence in Git history

Before this baseline, none of the four core materials below existed in any
Git commit reachable from any ref that could be found on this machine
(local repos, bundle files, reflogs).

## 3. Source files (pre-recovery, loose files)

| File | Absolute path | Bytes | Lines | SHA-256 |
|---|---|---|---|---|
| r3-batch7-postgres-authority-DESIGN-REPORT.md | /tmp/claude-1000/-home-ubuntu/c8d9e2d8-889a-4af7-97cf-808bd5f72f6e/scratchpad/frozen-test-evidence/r3-batch7-postgres-authority-DESIGN-REPORT.md | 109752 | 556 | 926ae6463af3ebfdbce1d7ea642fb17b9bf191aa7d5384a08f5867fbb948afab |
| BATCH7_EXECUTION_AUTHORITY_DESIGN_FINAL_CORRECTIONS.md | /tmp/claude-1000/-home-ubuntu/c8d9e2d8-889a-4af7-97cf-808bd5f72f6e/scratchpad/frozen-test-evidence/BATCH7_EXECUTION_AUTHORITY_DESIGN_FINAL_CORRECTIONS.md | 56872 | 522 | a1c526ddd87bc5053f4f8780183f1a2792ec0b1be43c8e0d670fa3d23c99b56d |
| BATCH7_ARTIFACT_PUBLICATION_PROTOCOL_SINGLE_ISSUE_CORRECTION.md | /tmp/claude-1000/-home-ubuntu/c8d9e2d8-889a-4af7-97cf-808bd5f72f6e/scratchpad/frozen-test-evidence/BATCH7_ARTIFACT_PUBLICATION_PROTOCOL_SINGLE_ISSUE_CORRECTION.md | 37836 | 422 | 1d9487dcbdf511c71f243757c4f1838a8ca072bfeb08a8f24a930dfc79dfd24d |
| BATCH7_G2_G3_DE_NOVO_FINAL_REVIEW.md | /tmp/claude-1000/-home-ubuntu/c8d9e2d8-889a-4af7-97cf-808bd5f72f6e/scratchpad/frozen-test-evidence/BATCH7_G2_G3_DE_NOVO_FINAL_REVIEW.md | 27340 | 208 | a725124fefcedc04a7e3fd438653f242db8c5ffb1c50c66f2431eca3a932101a |

## 4. Archived files (this commit) — must equal section 3 byte-for-byte

| File | Path in repo | Bytes | Lines | SHA-256 |
|---|---|---|---|---|
| r3-batch7-postgres-authority-DESIGN-REPORT.md | docs/batch7/g2-g3-baseline/r3-batch7-postgres-authority-DESIGN-REPORT.md | 109752 | 556 | 926ae6463af3ebfdbce1d7ea642fb17b9bf191aa7d5384a08f5867fbb948afab |
| BATCH7_EXECUTION_AUTHORITY_DESIGN_FINAL_CORRECTIONS.md | docs/batch7/g2-g3-baseline/BATCH7_EXECUTION_AUTHORITY_DESIGN_FINAL_CORRECTIONS.md | 56872 | 522 | a1c526ddd87bc5053f4f8780183f1a2792ec0b1be43c8e0d670fa3d23c99b56d |
| BATCH7_ARTIFACT_PUBLICATION_PROTOCOL_SINGLE_ISSUE_CORRECTION.md | docs/batch7/g2-g3-baseline/BATCH7_ARTIFACT_PUBLICATION_PROTOCOL_SINGLE_ISSUE_CORRECTION.md | 37836 | 422 | 1d9487dcbdf511c71f243757c4f1838a8ca072bfeb08a8f24a930dfc79dfd24d |
| BATCH7_G2_G3_DE_NOVO_FINAL_REVIEW.md | docs/batch7/g2-g3-baseline/BATCH7_G2_G3_DE_NOVO_FINAL_REVIEW.md | 27340 | 208 | a725124fefcedc04a7e3fd438653f242db8c5ffb1c50c66f2431eca3a932101a |

Sections 3 and 4 are identical item-for-item. Byte identity was re-verified
by direct `sha256sum` at each of three points: original loose file → fixed
intermediate copy → file staged into this commit.

## 5. Versions and supersession

- `BATCH7_G2_G3_DE_NOVO_FINAL_REVIEW.md` is the de novo review and is the
  operative review document for G2/G3 in this baseline.
- `BATCH7_EXECUTION_AUTHORITY_DESIGN_FINAL_CORRECTIONS.md` and
  `BATCH7_ARTIFACT_PUBLICATION_PROTOCOL_SINGLE_ISSUE_CORRECTION.md` are the
  final-corrections versions of their respective subjects; no other version
  of either was found among the recovered materials.
- `r3-batch7-postgres-authority-DESIGN-REPORT.md` is the design report for
  Postgres execution authority referenced by the above.
- Artifact publication: the single-issue correction document is the
  effective version for this baseline (no later correction was found).

## 6. De novo review conclusion

`DE_NOVO_G2_G3_DESIGN_APPROVED`

## 7. Retracted prior conclusion

`G2_G3_RECOVERY_APPROVED` is retracted and is **not** part of this baseline.

## 8. G1 scope

`NOT_REVIEWED_IN_THIS_DE_NOVO_G2_G3_REVIEW`

## 9. Production code

`NOT_STARTED`

## 10. PostgreSQL 16 non-skip validation

`MISSING / OUT_OF_SCOPE`

## 11. 180-day research

`NOT_STARTED / NOT_AUTHORIZED`

## 12. Implementation authorization

`NOT_GRANTED_BY_THIS_RECOVERY`

## 13. Trusted starting point

`239302eb48311882ea2f3fa2a4bd227b2b767b64`

Sourced from bundle:
`/tmp/claude-1000/-home-ubuntu/c8d9e2d8-889a-4af7-97cf-808bd5f72f6e/scratchpad/frozen-test-evidence/r3-batch7-finalize-no-undo-fix-complete-history.bundle`
(SHA-256: `9c0371a675c726194016845d5bfde687f374a91d5ebcacfaacc8706df8b7339e`),
the sole ref `refs/heads/claude/r3-batch7-p0-p1-scoped-fix`, verified as a
complete, self-contained history by `git bundle verify`.

## 14. Previously reported archive commit

`c0e470dbbd477aaf84510a44ea9eb20e6bcce18e`:
`PREVIOUSLY_REPORTED_BUT_NOT_FOUND_AND_NOT_ACCEPTED_AS_A_GIT_OBJECT`

## 15. Why the prior commit is not treated as this baseline's origin

No commit with this SHA was found in any locally checked repository, any
bundle file, any ref, or any reflog. It is not asserted to have ever
existed as a real Git object. The four core materials in this baseline were
recovered from real loose files, not from that commit's tree, because that
commit's tree cannot be read — it does not exist here.

## 16. Commit SHA of this manifest

This manifest does not and cannot record the SHA of the commit it is about
to become part of. That SHA is recorded only in the layer-two recovery
report, written after this commit exists.
