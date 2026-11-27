# RAG evaluation set (WP-2.5)

Labeled questions in `evals/rag/` gate retrieval changes. A retrieval PR cannot merge if the eval fails, unless `RAG_EVAL_SKIP=true` is set explicitly.

```
evals/rag/corpus.json       → fixture documents (stable source ids)
evals/rag/questions.json    → ≥50 golden pairs
lookupRelevantDocumentChunks
        ↓
Recall@5 / @10, Precision@5, MRR, nDCG@10
grounded-answer rate, hallucination rate
isolation violations, latency
        ↓
evals/rag/artifacts/last-run.json
```

No extra vendor. Embeddings in the gate are topic-aligned fixture vectors so CI does not call OpenAI. Lexical search is real Postgres FTS (WP-2.3). Tenant B’s `secret-tenant-b` chunk must never appear in tenant A results.

## Metrics

| Metric | Meaning |
| --- | --- |
| Recall@K | Fraction of gold sources found in the top K. |
| Precision@5 | Fraction of the top 5 that are gold sources. |
| MRR | Reciprocal rank of the first gold source. |
| nDCG@10 | Discounted ranking quality. |
| Citation coverage | At least one gold source retrieved. |
| Grounded-answer rate | `verifyGroundedClaims(goldAnswer, retrievedText)` passes. |
| Hallucination rate | A labeled ungrounded answer is incorrectly accepted. |
| Isolation violations | Tenant B source ids retrieved for tenant A. |

Retrieval averages skip questions with an empty relevant set (negatives / isolation probes). Those still count toward hallucination, isolation, and latency.

## Thresholds

Configured via env (defaults in `src/env.ts`):

| Env | Default |
| --- | --- |
| `RAG_EVAL_MIN_RECALL_AT_5` | `0.8` |
| `RAG_EVAL_MIN_RECALL_AT_10` | `0.85` |
| `RAG_EVAL_MIN_PRECISION_AT_5` | `0.35` |
| `RAG_EVAL_MIN_MRR` | `0.7` |
| `RAG_EVAL_MIN_NDCG_AT_10` | `0.75` |
| `RAG_EVAL_MIN_CITATION_COVERAGE` | `0.85` |
| `RAG_EVAL_MIN_GROUNDED_RATE` | `0.75` |
| `RAG_EVAL_MAX_HALLUCINATION_RATE` | `0.05` |
| `RAG_EVAL_MAX_ISOLATION_VIOLATIONS` | `0` |
| `RAG_EVAL_MAX_P95_MS` | `2000` |
| `RAG_EVAL_SKIP` | `false` |
| `RAG_EVAL_ARTIFACT_PATH` | `evals/rag/artifacts/last-run.json` |

## Running it (WP-3.5)

```
npm run eval:rag                          # run the gate, print a readable report
npm run eval:rag -- --update-baseline     # accept the current numbers as the new baseline
npm run eval:rag -- --max-regression 0.05 # loosen the regression slack for one run
```

Exit code is non-zero when either gate fails, so this drops straight into CI. The scoring harness stays in `tests/eval/ragEval.test.ts` — it needs the deterministic embedding mock, and running 64 questions against the real embedding provider on every invocation would cost quota and make the numbers irreproducible. The CLI drives that harness and reports on the artifact it writes.

## Regression gate (WP-3.5)

Absolute thresholds answer "is retrieval good enough". They cannot answer "did this change make it worse": a run can fall from 0.98 to 0.81 and still clear the 0.80 floor. Every run is therefore also compared against `evals/rag/baseline.json`, the last accepted run.

| Env | Default | Meaning |
| --- | --- | --- |
| `RAG_EVAL_BASELINE_PATH` | `evals/rag/baseline.json` | Last accepted run. |
| `RAG_EVAL_MAX_REGRESSION` | `0.03` | Largest allowed per-metric drop. Absorbs run-to-run noise. |
| `RAG_EVAL_UPDATE_BASELINE` | `false` | Re-baseline. Only writes if the run passed both gates. |

Isolation violations get no slack — any increase is a tenant-leak regression and fails immediately. Latency is reported with deltas but not gated here; `RAG_EVAL_MAX_P95_MS` already owns it, and p95 over 64 questions is too noisy to diff.

A missing baseline is the normal first-run state and passes. After an intentional quality change, re-baseline in the same commit so the next run compares against the new reality.

## Per-kind breakdown (WP-3.5)

The report also slices every metric by question kind (`lexical`, `synonym`, `negative`, `isolation`). A flat aggregate can hide a synonym-recall collapse offset by lexical gains, which is exactly what a retrieval or rerank change tends to introduce. Kinds with no gold set (negatives) print `n/a` for retrieval rather than a misleading `0.0%`.

## Rollback

Set `RAG_EVAL_SKIP=true` only as an explicit CI override. Do not leave it on.

## Production checklist

Grow the labeled set toward 50–100 pairs before treating hybrid as frozen. This repo ships ≥50 pairs now; add labels in `evals/rag/questions.json` rather than weakening thresholds.
