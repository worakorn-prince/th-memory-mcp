# th-memory-mcp Benchmark Report

- Project: v2.2.4 (df1a118)
- Benchmark spec: v1.0
- Run mode: warm
- Timestamp: 2026-08-31T00:34:34.446Z
- Node: v26.1.0 | OS: Windows_NT 10.0.19045
- CPU: AMD Ryzen 7 2700U with Radeon Vega Mobile Gfx   (x8) | RAM: 15261MB
- better-sqlite3: 12.11.1

## A.storage
- preferenceInsertSuccess: 1
- preferenceRoundTrip: 1
- lessonInsertSuccess: 1
- lessonRoundTrip: 1
- forgetCorrectness: 1
- storageCorrectness: 1
- notes: inserted 60 prefs + 40 lessons into a fresh temp DB

## B.retrieval
- dataset: 180
- recallAt1: 0.2000
- recallAt3: 0.6000
- recallAt5: 0.9200
- recallAt10: 0.9733
- precisionAt1: 1
- precisionAt3: 1
- precisionAt5: 0.9200
- precisionAt10: 0.4867
- mrr: 1
- ndcgAt5: 0.9445
- ndcgAt10: 0.9765
- notes: Recall@K/Precision@K/MRR/NDCG over 30 topics (5 relevant + 30 distractors)

## C.temporal
- currentStateAccuracy: 1
- historicalStateAccuracy: 1
- supersessionAccuracy: 1
- notes: 20 temporal cases via get_context (current/historical/supersession) §7

## C.conflict
- conflictResolutionAccuracy: 1
- falseConflictScopeAccuracy: 0
- crossScopeContaminationRate: 0
- notes: true conflict (20) + false conflict by scope (20) via get_context §8

## C.scope
- scopeSelectionAccuracy: 1
- crossScopeContaminationRate: 0.7500
- notes: 4 scopes (USER/SESSION/PROJECT/GLOBAL) + 40 distractors via get_context §9

## D.context
- budget_256:
  - criticalCoverage: 0.7500
  - relevantTokenRatio: 1
  - noiseRatio: 0
  - contextRelevance: 1
  - infoDensity: 38.4615
  - tokensUsed: 234
  - truncated: true
  - accuracyPerToken: 0.0032
- budget_512:
  - criticalCoverage: 1
  - relevantTokenRatio: 1
  - noiseRatio: 0
  - contextRelevance: 1
  - infoDensity: 38.0952
  - tokensUsed: 315
  - truncated: false
  - accuracyPerToken: 0.0032
- budget_1024:
  - criticalCoverage: 1
  - relevantTokenRatio: 1
  - noiseRatio: 0
  - contextRelevance: 1
  - infoDensity: 38.0952
  - tokensUsed: 315
  - truncated: false
  - accuracyPerToken: 0.0032
- budget_2048:
  - criticalCoverage: 1
  - relevantTokenRatio: 1
  - noiseRatio: 0
  - contextRelevance: 1
  - infoDensity: 38.0952
  - tokensUsed: 315
  - truncated: false
  - accuracyPerToken: 0.0032
- budget_4096:
  - criticalCoverage: 1
  - relevantTokenRatio: 1
  - noiseRatio: 0
  - contextRelevance: 1
  - infoDensity: 38.0952
  - tokensUsed: 315
  - truncated: false
  - accuracyPerToken: 0.0032
- budget_8192:
  - criticalCoverage: 1
  - relevantTokenRatio: 1
  - noiseRatio: 0
  - contextRelevance: 1
  - infoDensity: 38.0952
  - tokensUsed: 315
  - truncated: false
  - accuracyPerToken: 0.0032
- notes: token-budget sweep (§11,§16,§17): 12 critical + 60 irrelevant memories

## E.performance
- operations: 9
- latency[remember](ms): min=0 mean=2.4000 p95=3.0000 p99=33.4000 max=41
- latency[recall](ms): min=0 mean=0.6500 p95=1.0500 p99=1.8100 max=2
- latency[getContext](ms): min=0 mean=0.4000 p95=1 p99=1 max=1
- latency[retrieve](ms): min=0 mean=0.5500 p95=1 p99=1 max=1
- latency[createMemory](ms): min=0 mean=0.7000 p95=1 p99=1 max=1
- latency[updateMemory](ms): min=1 mean=5.2500 p95=7.4500 p99=44.6900 max=54
- latency[mergeMemory](ms): min=1 mean=5.0500 p95=8.4500 p99=45.6900 max=55
- latency[linkMemory](ms): min=1 mean=3.4500 p95=4.0000 p99=34.4000 max=42
- latency[forget](ms): min=1 mean=1.0500 p95=1.0500 p99=1.8100 max=2
- notes: warmup=10 iterations=20 (warm only; cold not yet implemented)

## F.scalability
- memoriesInserted: 500
- memoriesPerSec: 584.7953
- dbSizeMB: 6.2536
- mbPer1kMemories: 12.5072
- peakRssMB: 54.7617
- rssGrowthMB: 0
- cpuUserMs: 203
- cpuSysMs: 156
- notes: throughput + DB size + CPU/RAM (§13,§14,§15). cold-state not yet implemented (needs subprocess).

## E.cold
- operations: 5
- samples: 20
- latency[remember](ms): min=0 mean=1 p95=2 p99=2 max=2
- latency[recall](ms): min=3 mean=4.3000 p95=5 p99=5 max=5
- latency[getContext](ms): min=6 mean=8.2000 p95=10.0500 p99=10.8100 max=11
- latency[retrieve](ms): min=6 mean=6.8500 p95=8 p99=8 max=8
- latency[createMemory](ms): min=0 mean=0.8000 p95=1.0500 p99=1.8100 max=2
- notes: cold = fresh process + fresh DB per call; reports min/mean/p95/max over 20 spawns (§12.2)

## B.ablation
- fts_only:
  - recallAt1: 0.2000
  - recallAt3: 0.6000
  - recallAt5: 1
  - recallAt10: 1
  - mrr: 1
  - ndcgAt5: 1
  - ndcgAt10: 1
- vec_only:
  - recallAt1: 0.2000
  - recallAt3: 0.4867
  - recallAt5: 0.6933
  - recallAt10: 0.8600
  - mrr: 1
  - ndcgAt5: 0.7667
  - ndcgAt10: 0.8586
- fts_vec_sumrank:
  - recallAt1: 0.2000
  - recallAt3: 0.5933
  - recallAt5: 0.9533
  - recallAt10: 0.9800
  - mrr: 1
  - ndcgAt5: 0.9666
  - ndcgAt10: 0.9825
- fts_vec_rrf:
  - recallAt1: 0.2000
  - recallAt3: 0.5933
  - recallAt5: 0.9467
  - recallAt10: 0.9867
  - mrr: 1
  - ndcgAt5: 0.9622
  - ndcgAt10: 0.9857
- fts_vec_rrf_graph:
  - recallAt1: 0.2000
  - recallAt3: 0.5933
  - recallAt5: 0.9467
  - recallAt10: 0.9867
  - mrr: 1
  - ndcgAt5: 0.9622
  - ndcgAt10: 0.9857
- notes: retrieval ablation (§6): FTS / Vector / FTS+Vector / FTS+Vector+RRF / +Graph over 30 topics; +Graph equals RRF (dataset has no links)
