# th-memory-mcp Benchmark Report

- Project: v2.2.6 (b33d850)
- Benchmark spec: v1.0
- Run mode: warm
- Timestamp: 2026-08-31T17:39:00.930Z
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
- dataset: 600
- recallAt1: 0.2000
- recallAt3: 0.5960
- recallAt5: 0.9060
- recallAt10: 0.9680
- precisionAt1: 1
- precisionAt3: 0.9933
- precisionAt5: 0.9060
- precisionAt10: 0.4840
- mrr: 1
- ndcgAt5: 0.9347
- ndcgAt10: 0.9713
- notes: Recall@K/Precision@K/MRR/NDCG over 100 topics (5 relevant + 100 distractors)

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
- latency[remember](ms): min=0 mean=3.6000 p95=4.1500 p99=52.0300 max=64
- latency[recall](ms): min=0 mean=0.5500 p95=1 p99=1 max=1
- latency[getContext](ms): min=0 mean=0.4500 p95=1 p99=1 max=1
- latency[retrieve](ms): min=0 mean=0.3500 p95=1 p99=1 max=1
- latency[createMemory](ms): min=0 mean=0.7000 p95=1 p99=1 max=1
- latency[updateMemory](ms): min=1 mean=4.7000 p95=5.5500 p99=44.3100 max=54
- latency[mergeMemory](ms): min=2 mean=5.7000 p95=7.1000 p99=54.2200 max=66
- latency[linkMemory](ms): min=1 mean=4.0500 p95=5.2500 p99=39.4500 max=48
- latency[forget](ms): min=0 mean=3.5000 p95=10.6000 p99=34.9200 max=41
- notes: warmup=10 iterations=20 (warm only; cold not yet implemented)

## F.scalability
- memoriesInserted: 2000
- memoriesPerSec: 434.5937
- dbSizeMB: 12.7810
- mbPer1kMemories: 6.3905
- peakRssMB: 103.3008
- rssGrowthMB: 2.9375
- cpuUserMs: 1454
- cpuSysMs: 1188
- notes: throughput + DB size + CPU/RAM (§13,§14,§15). cold-state not yet implemented (needs subprocess).

## E.cold
- operations: 9
- samples: 20
- latency[remember](ms): min=0 mean=1.1500 p95=2 p99=2 max=2
- latency[recall](ms): min=4 mean=4.8500 p95=6 p99=6 max=6
- latency[getContext](ms): min=9 mean=10.8500 p95=14 p99=14 max=14
- latency[retrieve](ms): min=6 mean=8.0500 p95=10.0500 p99=10.8100 max=11
- latency[createMemory](ms): min=0 mean=1 p95=2.0500 p99=2.8100 max=3
- latency[updateMemory](ms): min=3 mean=3.4500 p95=5 p99=5 max=5
- latency[mergeMemory](ms): min=2 mean=4 p95=6 p99=6 max=6
- latency[linkMemory](ms): min=1 mean=2.6000 p95=4 p99=4 max=4
- latency[forget](ms): min=1 mean=2.2500 p95=3 p99=3 max=3
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
  - recallAt1: 0.1920
  - recallAt3: 0.4520
  - recallAt5: 0.6260
  - recallAt10: 0.8100
  - mrr: 0.9783
  - ndcgAt5: 0.7077
  - ndcgAt10: 0.8100
- fts_vec_sumrank:
  - recallAt1: 0.2000
  - recallAt3: 0.5780
  - recallAt5: 0.9360
  - recallAt10: 0.9600
  - mrr: 1
  - ndcgAt5: 0.9526
  - ndcgAt10: 0.9662
- fts_vec_rrf:
  - recallAt1: 0.2000
  - recallAt3: 0.5800
  - recallAt5: 0.9340
  - recallAt10: 0.9620
  - mrr: 1
  - ndcgAt5: 0.9515
  - ndcgAt10: 0.9678
- fts_vec_rrf_graph:
  - recallAt1: 0.2000
  - recallAt3: 0.5800
  - recallAt5: 0.9340
  - recallAt10: 0.9620
  - mrr: 1
  - ndcgAt5: 0.9515
  - ndcgAt10: 0.9678
- notes: retrieval ablation (§6): FTS / Vector / FTS+Vector / FTS+Vector+RRF / +Graph over 100 topics; +Graph equals RRF (dataset has no links)
