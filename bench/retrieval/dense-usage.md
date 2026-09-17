# Local embedding baseline

`dense.py` ranks repository files using actual local sentence embeddings. It does
not generate answers and receives no gold labels. The default model is
[all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2),
pinned to commit `1110a243fdf4706b3f48f1d95db1a4f5529b4d41`. Its model card describes
384-dimensional sentence embeddings and warns that default encoding truncates
long inputs. This runner avoids that truncation.

```sh
python3 -m venv .cache/bench/venv
.cache/bench/venv/bin/pip install torch==2.9.1 --index-url https://download.pytorch.org/whl/cpu
.cache/bench/venv/bin/pip install -r bench/retrieval/requirements.txt
.cache/bench/venv/bin/python bench/retrieval/dense.py \
  --input input.json --output results.json --cache .cache/bench/dense
python3 -m unittest discover -s bench/retrieval -p 'test_dense.py'
```

Use a clean virtual environment: mismatched system `torchvision` installations
can break a text-only Sentence Transformers import. No GPU or API key is needed;
the first execution downloads public model weights. Remote model code is disabled
and weights use safetensors. Alternate models require an explicit commit SHA.

Input shape:

```json
{"corpora":[{"id":"example","files":[{"path":"auth.py","text":"source"}],"queries":[{"id":"q1","query":"Where is authentication checked?"}]}],"limit":10}
```

Every source token is covered by overlapping windows of at most 192 tokens total,
including model special tokens and a path prefix bounded to 32 tokens. Adjacent
content windows overlap by 32 tokens. Long queries are also fully chunked; their
normalized chunk vectors are averaged and normalized again. File ranking is the
maximum cosine across its chunks, with path order breaking exact ties. This is a
fixed, general sentence-embedding retrieval baseline, not a claim of an optimized
code-specific RAG system.

The output reports setup time (imports/model load), per-query wall latency,
current corpus build/load time (`buildMs`), cached original encoding time
(`coldBuildMs`), cache hit status, and chunk count. Cold encoding excludes cache
serialization; current `buildMs` includes it. Caches hash complete file content,
paths, model, exact revision and chunk settings. Query timing includes encoding,
cosine scoring and file reduction; it excludes model setup and corpus indexing.
Do not mix cold indexing or initial downloads into steady-state query latency.
