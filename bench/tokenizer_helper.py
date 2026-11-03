#!/usr/bin/env python3
"""Token-counting helper for bench/tokens.ts.

Reads JSON lines of {"text": ...} on stdin and writes one {"count": n} JSON line per
input, in order. argv[1] is the tokenizer.json to load (the target model family's,
downloaded under ~/workspace/tools/lfm-tokenizer/). Counts are the lengths of the
tokenizer's own encodings — whatever its post-processor adds is part of the count,
exactly as the model's serving stack would see it. No network, no other files.
"""

import json
import sys

from tokenizers import Tokenizer


def main() -> int:
    tokenizer = Tokenizer.from_file(sys.argv[1])
    texts = []
    for line in sys.stdin:
        line = line.strip()
        if line:
            texts.append(json.loads(line)["text"])
    out = sys.stdout
    for encoding in tokenizer.encode_batch(texts):
        out.write(json.dumps({"count": len(encoding.ids)}) + "\n")
    out.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
