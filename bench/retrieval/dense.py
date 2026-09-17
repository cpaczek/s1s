#!/usr/bin/env python3
"""Pinned, local sentence-embedding retrieval baseline. No gold labels or generation.

Model reference: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
All source and query tokens are encoded in overlapping windows; files are ranked
by maximum chunk cosine. See dense-usage.md for setup and accounting.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time

DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
DEFAULT_REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
CACHE_SCHEMA = 1


def token_windows(tokens: list[int], size: int, overlap: int) -> list[list[int]]:
    """Cover every token, including tails and empty files, without oversized input."""
    if size < 1 or overlap < 0 or overlap >= size:
        raise ValueError("Require 0 <= overlap < content window size")
    if not tokens:
        return [[]]
    windows = []
    start = 0
    while start < len(tokens):
        windows.append(tokens[start:start + size])
        if start + size >= len(tokens):
            break
        start += size - overlap
    return windows


def rank_files(scores, owners, paths: list[str], limit: int) -> list[str]:
    """Reduce chunks by max cosine; exact ties use the repository-relative path."""
    best = {path: float("-inf") for path in paths}
    for score, owner in zip(scores, owners, strict=True):
        path = paths[int(owner)]
        best[path] = max(best[path], float(score))
    return sorted(paths, key=lambda path: (-best[path], path))[:limit]


def cache_key(files: list[dict], model: str, revision: str, settings: dict) -> str:
    digest = hashlib.sha256()
    for part in (CACHE_SCHEMA, model, revision, settings, files):
        # Length-delimited canonical JSON: names/text cannot create delimiter collisions.
        encoded = json.dumps(part, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    return digest.hexdigest()


def validate_input(data: dict) -> None:
    if not isinstance(data, dict) or not isinstance(data.get("corpora"), list):
        raise ValueError("Input must contain a corpora array")
    limit = data.get("limit", 10)
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
        raise ValueError("limit must be a positive integer")
    ids = set()
    for corpus in data["corpora"]:
        if not isinstance(corpus, dict) or not isinstance(corpus.get("id"), str) or corpus["id"] in ids:
            raise ValueError("Each corpus needs a unique string id")
        ids.add(corpus["id"])
        for field, keys, unique in (("files", ("path", "text"), "path"), ("queries", ("id", "query"), "id")):
            rows = corpus.get(field)
            if not isinstance(rows, list) or any(not isinstance(row, dict) or any(not isinstance(row.get(k), str) for k in keys) for row in rows):
                raise ValueError(f"Invalid corpus {field}")
            if len({row[unique] for row in rows}) != len(rows):
                raise ValueError(f"Duplicate {field} identifiers")
        if not corpus["files"]:
            raise ValueError("A corpus must have at least one file")


class Encoder:
    def __init__(self, model, sequence_tokens: int, overlap: int, path_tokens: int, batch_size: int):
        self.model = model
        self.tokenizer = model.tokenizer
        self.sequence_tokens = min(sequence_tokens, model.max_seq_length)
        self.overlap = overlap
        self.path_tokens = path_tokens
        self.batch_size = batch_size
        self.special_tokens = self.tokenizer.num_special_tokens_to_add(pair=False)
        if self.sequence_tokens - self.special_tokens - self.path_tokens - 1 <= overlap:
            raise ValueError("Path prefix and overlap leave no content window")

    def chunks(self, text: str, path: str | None = None) -> list[list[int]]:
        prefix = []
        if path is not None:
            prefix = self.tokenizer.encode(path, add_special_tokens=False, truncation=False, verbose=False)[:self.path_tokens]
            if prefix and self.tokenizer.sep_token_id is not None:
                prefix.append(self.tokenizer.sep_token_id)
        # No implicit truncation: these exact IDs reach the encoder without a decode/re-tokenize step.
        tokens = self.tokenizer.encode(text, add_special_tokens=False, truncation=False, verbose=False)
        content_size = self.sequence_tokens - self.special_tokens - len(prefix)
        return [prefix + window for window in token_windows(tokens, content_size, self.overlap)]

    def encode(self, chunks: list[list[int]]):
        import numpy as np
        import torch
        import torch.nn.functional as functional
        batches = []
        for offset in range(0, len(chunks), self.batch_size):
            rows = [self.tokenizer.prepare_for_model(ids, add_special_tokens=True, truncation=False, return_attention_mask=True) for ids in chunks[offset:offset + self.batch_size]]
            if any(len(row["input_ids"]) > self.sequence_tokens for row in rows):
                raise ValueError("Chunk exceeded the model input budget")
            features = self.tokenizer.pad(rows, padding=True, return_tensors="pt", verbose=False)
            with torch.inference_mode():
                embedded = self.model(features)["sentence_embedding"]
                batches.append(functional.normalize(embedded, p=2, dim=1).cpu().numpy().astype(np.float32))
        return np.concatenate(batches, axis=0)

    def query(self, text: str):
        import numpy as np
        parts = self.encode(self.chunks(text))
        mean = parts.mean(axis=0)
        norm = np.linalg.norm(mean)
        return mean / norm if norm else mean


def retrieve_corpus(corpus: dict, encoder: Encoder, model: str, revision: str, cache: Path, settings: dict, limit: int) -> dict:
    import numpy as np
    start = time.perf_counter()
    files = sorted(corpus["files"], key=lambda file: file["path"])
    paths = [file["path"] for file in files]
    key = cache_key(files, model, revision, settings)
    target = cache / (key + ".npz")
    cache_hit = target.exists()
    if cache_hit:
        with np.load(target, allow_pickle=False) as saved:
            vectors = saved["vectors"]
            owners = saved["owners"]
            cold_build_ms = float(saved["cold_build_ms"])
        if vectors.ndim != 2 or owners.ndim != 1 or len(owners) != len(vectors) or not np.isfinite(vectors).all() or np.any(owners < 0) or np.any(owners >= len(paths)):
            raise ValueError(f"Corrupt embedding cache: {target}")
    else:
        chunks = []
        owner_list = []
        for owner, file in enumerate(files):
            windows = encoder.chunks(file["text"], file["path"])
            chunks.extend(windows)
            owner_list.extend([owner] * len(windows))
        vectors = encoder.encode(chunks)
        owners = np.asarray(owner_list, dtype=np.int32)
        cold_build_ms = (time.perf_counter() - start) * 1000
        temporary = target.with_suffix(f".{os.getpid()}.tmp")
        try:
            with temporary.open("wb") as stream:
                np.savez(stream, vectors=vectors, owners=owners, cold_build_ms=np.asarray(cold_build_ms))
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    build_ms = (time.perf_counter() - start) * 1000
    rows = []
    for query in corpus["queries"]:
        query_start = time.perf_counter()
        query_vector = encoder.query(query["query"])
        ranked = rank_files(vectors @ query_vector, owners, paths, limit)
        rows.append({"id": query["id"], "ranked": ranked, "latencyMs": round((time.perf_counter() - query_start) * 1000, 3)})
    return {"id": corpus["id"], "buildMs": round(build_ms, 3), "coldBuildMs": round(cold_build_ms, 3), "cacheHit": cache_hit, "chunks": len(owners), "rows": rows}


def main() -> None:
    start = time.perf_counter()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--revision")
    parser.add_argument("--chunk-tokens", type=int, default=192)
    parser.add_argument("--overlap", type=int, default=32)
    parser.add_argument("--path-tokens", type=int, default=32)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    if args.batch_size < 1 or args.threads < 1 or args.path_tokens < 0:
        parser.error("batch-size/threads must be positive; path-tokens must be nonnegative")
    revision = args.revision or (DEFAULT_REVISION if args.model == DEFAULT_MODEL else None)
    if revision is None or len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        parser.error("--revision must pin a 40-character lowercase model commit SHA")
    data = json.loads(args.input.read_text())
    validate_input(data)
    args.cache.mkdir(parents=True, exist_ok=True)
    # No token/credential use, remote model code, GPU auto-selection or generation.
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    import torch
    from sentence_transformers import SentenceTransformer
    torch.set_num_threads(args.threads)
    torch.manual_seed(0)
    torch.use_deterministic_algorithms(True)
    model = SentenceTransformer(args.model, revision=revision, device="cpu", trust_remote_code=False, token=False, cache_folder=str(args.cache / "models"), model_kwargs={"use_safetensors": True})
    model.eval()
    encoder = Encoder(model, args.chunk_tokens, args.overlap, args.path_tokens, args.batch_size)
    settings = {"sequenceTokens": encoder.sequence_tokens, "overlap": args.overlap, "pathTokens": args.path_tokens, "batchSize": args.batch_size, "torch": torch.__version__}
    output = {"model": args.model, "revision": revision, "device": "cpu", "setupMs": round((time.perf_counter() - start) * 1000, 3), "settings": settings, "corpora": []}
    for corpus in data["corpora"]:
        print(f"Embedding retrieval: {corpus['id']} ({len(corpus['files'])} files)", file=sys.stderr, flush=True)
        output["corpora"].append(retrieve_corpus(corpus, encoder, args.model, revision, args.cache, settings, data.get("limit", 10)))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n")


if __name__ == "__main__":
    main()
