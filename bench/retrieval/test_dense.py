import unittest

from dense import Encoder, cache_key, rank_files, token_windows, validate_input


class DenseRetrievalTests(unittest.TestCase):
    def test_every_token_including_tail_is_encoded_with_overlap(self):
        tokens = list(range(500))
        windows = token_windows(tokens, 192, 32)
        self.assertTrue(all(len(window) <= 192 for window in windows))
        self.assertEqual(set(tokens), {token for window in windows for token in window})
        self.assertEqual(windows[0][-32:], windows[1][:32])
        self.assertEqual(windows[-1][-1], 499)

    def test_encoder_keeps_all_source_and_query_tokens_with_bounded_prefix(self):
        class Tokenizer:
            sep_token_id = 9999
            def encode(self, text, **kwargs):
                return [int(token) for token in text.split()]
            def num_special_tokens_to_add(self, **kwargs):
                return 2
        class Model:
            tokenizer = Tokenizer()
            max_seq_length = 256
        encoder = Encoder(Model(), 192, 32, 32, 32)
        text = ' '.join(map(str, range(100, 600)))
        source_chunks = encoder.chunks(text, ' '.join(map(str, range(80))))
        self.assertTrue(all(len(chunk) + 2 <= 192 for chunk in source_chunks))
        self.assertTrue(all(chunk[:32] == list(range(32)) for chunk in source_chunks))
        self.assertEqual({token for chunk in source_chunks for token in chunk[33:]}, set(range(100, 600)))
        query_chunks = encoder.chunks(text)
        self.assertEqual({token for chunk in query_chunks for token in chunk}, set(range(100, 600)))

    def test_empty_and_invalid_chunk_settings(self):
        self.assertEqual(token_windows([], 192, 32), [[]])
        self.assertEqual(token_windows([1, 2], 192, 32), [[1, 2]])
        for size, overlap in [(0, 0), (32, 32), (32, -1)]:
            with self.assertRaises(ValueError):
                token_windows([1], size, overlap)

    def test_max_chunk_cosine_and_stable_ties_rank_each_file_once(self):
        paths = ['z.ts', 'a.ts', 'b.ts']
        self.assertEqual(rank_files([.1, .8, .8, .2], [0, 0, 1, 2], paths, 10), ['a.ts', 'z.ts', 'b.ts'])
        self.assertEqual(rank_files([.1, .8, .8, .2], [0, 0, 1, 2], paths, 1), ['a.ts'])

    def test_cache_changes_for_source_revision_and_chunking(self):
        files = [{'path': 'a.py', 'text': 'print(1)'}]
        base = cache_key(files, 'model', 'rev', {'overlap': 32})
        self.assertEqual(base, cache_key(files, 'model', 'rev', {'overlap': 32}))
        self.assertNotEqual(base, cache_key(files, 'model', 'rev2', {'overlap': 32}))
        self.assertNotEqual(base, cache_key(files, 'model', 'rev', {'overlap': 16}))
        self.assertNotEqual(base, cache_key([{'path': 'a.py', 'text': 'print(2)'}], 'model', 'rev', {'overlap': 32}))

    def test_input_rejects_duplicate_paths_and_needs_no_gold_labels(self):
        data = {'corpora': [{'id': 'tiny', 'files': [{'path': 'a.py', 'text': 'pass'}], 'queries': [{'id': 'q', 'query': 'what does it do'}]}], 'limit': 10}
        validate_input(data)
        data['corpora'][0]['files'].append({'path': 'a.py', 'text': 'different'})
        with self.assertRaises(ValueError):
            validate_input(data)


if __name__ == '__main__':
    unittest.main()
