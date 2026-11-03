#!/usr/bin/env python3
"""Reranker helper for bench/selection/rerank.ts (Wave B experiment).

Reads JSON lines of {"query": ..., "passage": ...} on stdin and writes one
{"score": x} JSON line per input, in order. argv[1] is the local model directory
(the public cl-nagoya/ruri-reranker-small snapshot under ~/workspace/tools/).
The score is the raw logit of the model's single label — the same ordering the
documented CrossEncoder usage produces (its sigmoid is monotonic, so ranking by
the logit and by the probability coincide). No network, no other files beyond
the model directory and the transformers module cache.
"""

import json
import sys

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

BATCH = 32
MAX_LENGTH = 512


def main() -> int:
    model_dir = sys.argv[1]
    tokenizer = AutoTokenizer.from_pretrained(model_dir, trust_remote_code=True)
    model = AutoModelForSequenceClassification.from_pretrained(model_dir)
    model.eval()
    torch.set_num_threads(max(1, (torch.get_num_threads())))
    pairs = []
    for line in sys.stdin:
        line = line.strip()
        if line:
            item = json.loads(line)
            pairs.append((item["query"], item["passage"]))
    out = sys.stdout
    with torch.inference_mode():
        for start in range(0, len(pairs), BATCH):
            chunk = pairs[start : start + BATCH]
            enc = tokenizer(
                chunk,
                padding=True,
                truncation=True,
                max_length=MAX_LENGTH,
                return_tensors="pt",
            )
            logits = model(**enc).logits
            for value in logits[:, -1].tolist():
                out.write(json.dumps({"score": value}) + "\n")
            out.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
