# -*- coding: utf-8 -*-
"""Testes do tap de captura em stream (fase item 8).

Cobrem os vetores exigidos — sequencia incremental, zeros, 0xff, tamanhos NAO
multiplos de 4, partial reads, partial writes, reconexao, stream longo e
captura real reproduzida — e as RESTRICOES: sem 2o consumidor, sem mutacao,
sem framing/delimitador/metadata no fluxo, sem descarte, sem duplicacao,
evidencia primaria = byte cru + SHA-256 (nao representacao textual).
NADA aqui toca a FPGA/FIFO/producao.
"""
import hashlib
import os
import random
import unittest

from stream_tap import (
    StreamTap, replay_through_tap, write_all, first_divergent_offset,
)

INCREMENTAL = bytes(range(256)) * 20                      # 5120 B, 8-bit ramp
ZEROS       = b"\x00" * 4096
FFS         = b"\xff" * 4096
NONMULT4    = bytes((i * 37 + 11) & 0xFF for i in range(4099))   # 4099 % 4 == 3
LONG        = bytes((i * 2654435761) & 0xFF for i in range(1_048_576 + 7))  # ~1 MiB, nao mult 4


def _sha(b): return hashlib.sha256(b).hexdigest()


class TestPreservacaoPorVetor(unittest.TestCase):
    """forward == entrada, byte a byte, para cada vetor."""

    def _roundtrip(self, name, src, chunks):
        res, fwd = replay_through_tap(f"cap-{name}", src, read_chunks=chunks)
        self.assertEqual(fwd, src, f"{name}: fluxo repassado != fonte")
        self.assertEqual(res.evidence_sha256, _sha(src), f"{name}: SHA-256 evidencia != fonte")
        self.assertTrue(res.forwarded_equals_input, f"{name}: forwarded_equals_input falso")
        self.assertEqual(res.total_forwarded, len(src))
        # nenhuma divergencia forward vs entrada em nenhum bloco
        for b in res.blocks:
            self.assertEqual(b.forward_first_divergent_offset, -1)
        # offsets contiguos, sem gap e sem sobreposicao (sem descarte/duplicacao)
        exp = 0
        for b in res.blocks:
            self.assertEqual(b.offset_start, exp)
            exp = b.offset_end
        self.assertEqual(exp, len(src))
        return res

    def test_incremental(self):
        self._roundtrip("incremental", INCREMENTAL, [256, 256, 256, 4352])

    def test_zeros_permanecem_zeros(self):
        res = self._roundtrip("zeros", ZEROS, [1, 1, 1, 4093])
        self.assertEqual(set(bytes.fromhex(res.blocks[0].hexdump_head.replace(" ", ""))), {0})

    def test_0xff(self):
        res = self._roundtrip("ff", FFS, [7, 9, 4080])
        self.assertEqual(set(bytes.fromhex(res.blocks[0].hexdump_head.replace(" ", ""))), {0xFF})

    def test_tamanho_nao_multiplo_de_quatro(self):
        # 4099 bytes; fatias que tambem nao alinham em 4
        res = self._roundtrip("nonmult4", NONMULT4, [1, 2, 3, 5, 7, 4081])
        self.assertEqual(res.total_forwarded % 4, 3)      # o tap nao "arruma" alinhamento

    def test_stream_longo(self):
        self._roundtrip("long", LONG, [4096] * 200 + [999999])


class TestPartialReads(unittest.TestCase):
    def test_partial_reads_de_1_byte_via_os_pipe(self):
        # read_size=1 forca cada os.read a devolver 1 byte -> N blocos de 1
        r_fd, w_fd = os.pipe()
        tap = StreamTap("cap-1b", out_fd=w_fd, read_size=1)
        import threading
        got = bytearray()

        def drain():
            while True:
                c = os.read(r_fd, 4096)
                if not c:
                    return
                got.extend(c)
        t = threading.Thread(target=drain, daemon=True); t.start()
        # alimenta a "fonte" byte a byte
        for byteval in NONMULT4:
            tap.pump_iter([bytes([byteval])])
        os.close(w_fd); t.join(timeout=5); os.close(r_fd)
        res = tap.finalize()
        self.assertEqual(bytes(got), NONMULT4)
        self.assertEqual(len(res.blocks), len(NONMULT4))     # 1 bloco por byte
        self.assertTrue(all(b.n_bytes == 1 for b in res.blocks))
        self.assertEqual(res.evidence_sha256, _sha(NONMULT4))


class TestPartialWrites(unittest.TestCase):
    def test_write_all_reencaminha_write_parcial(self):
        # fd falso cujo write devolve no maximo 3 bytes por chamada
        chunks_written = []

        real_write = os.write

        class FakeFD:
            pass

        # monkeypatch os.write so nesta funcao
        def short_write(fd, data):
            n = min(3, len(data))
            chunks_written.append(bytes(data[:n]))
            return n

        os.write = short_write
        try:
            total = write_all(123, b"abcdefghijkl")     # 12 bytes
        finally:
            os.write = real_write
        self.assertEqual(total, 12)
        self.assertEqual(b"".join(chunks_written), b"abcdefghijkl")
        self.assertTrue(all(len(c) <= 3 for c in chunks_written))

    def test_forward_completo_mesmo_com_write_parcial_no_pipe(self):
        # pipe com muitos bytes e leitor lento -> os.write no tap sofre write
        # parcial; write_all deve completar sem perder/duplicar
        big = LONG[:300_000]
        res, fwd = replay_through_tap("cap-pw", big, read_chunks=[65536] * 5 + [999999])
        self.assertEqual(fwd, big)
        self.assertEqual(res.evidence_sha256, _sha(big))


class TestReconexao(unittest.TestCase):
    def test_reconexao_registrada_no_sidecar_nao_no_fluxo(self):
        a = INCREMENTAL[:2000]
        b = FFS[:1000]                     # "retomada" apos reconexao (sem gap)
        res, fwd = replay_through_tap(
            "cap-reconnect", a,
            read_chunks=[512, 512, 512, 999],
            reconnect_after_bytes=len(a),
            resume_source=b,
        )
        self.assertEqual(fwd, a + b)                       # a repassado, depois b
        self.assertEqual(res.evidence_sha256, _sha(a + b))
        # a descontinuidade foi registrada FORA do fluxo
        self.assertEqual(len(res.discontinuities), 1)
        d = res.discontinuities[0]
        self.assertEqual(d.at_offset, len(a))
        self.assertIsNone(d.gap_bytes)     # o tap nao inventa o tamanho do gap
        # NENHUM byte de metadata entrou no fluxo
        self.assertEqual(len(fwd), len(a) + len(b))

    def test_reconexao_com_gap_real_nao_e_mascarada(self):
        # perda: a fonte "pula" 40 bytes na reconexao. O tap repassa o que
        # recebeu (a_head + b_tail) — MENOR que a fonte logica — e a divergencia
        # e detectavel comparando com a fonte logica completa.
        logical = INCREMENTAL[:3000]
        a_head = logical[:1200]
        b_tail = logical[1240:]           # 40 bytes perdidos no gap
        res, fwd = replay_through_tap(
            "cap-gap", a_head,
            read_chunks=[300, 300, 600, 99999],
            reconnect_after_bytes=len(a_head),
            resume_source=b_tail,
        )
        self.assertEqual(fwd, a_head + b_tail)
        self.assertNotEqual(fwd, logical)                  # perda visivel
        self.assertEqual(first_divergent_offset(fwd, logical), 1200)
        self.assertEqual(len(fwd), len(logical) - 40)      # exatamente 40 B a menos
        self.assertEqual(len(res.discontinuities), 1)


class TestCapturaRealReproduzida(unittest.TestCase):
    def test_replay_reproduzido_seed_20260827(self):
        # "captura real reproduzida": vetor deterministico com a MESMA seed do
        # fixture-upstream de staging (staging/fixture-upstream/app.py).
        rnd = random.Random(20260827)
        payload = bytes(rnd.getrandbits(8) for _ in range(200_003))   # nao mult 4
        res, fwd = replay_through_tap("cap-replay-20260827", payload,
                                      read_chunks=[4096] * 48 + [999999])
        self.assertEqual(fwd, payload)
        self.assertEqual(res.evidence_sha256, _sha(payload))
        self.assertTrue(res.forwarded_equals_input)

    def test_replay_e_deterministico_entre_execucoes(self):
        rnd1 = random.Random(20260827); p1 = bytes(rnd1.getrandbits(8) for _ in range(10_000))
        rnd2 = random.Random(20260827); p2 = bytes(rnd2.getrandbits(8) for _ in range(10_000))
        self.assertEqual(_sha(p1), _sha(p2))


class TestRestricoesDoTap(unittest.TestCase):
    def test_sem_framing_delimitador_ou_prefixo_de_tamanho(self):
        src = b"\x00\x01\x02\x03" + b"\xff" * 8 + b"\x0a\x0d"   # inclui \n \r
        res, fwd = replay_through_tap("cap-frame", src, read_chunks=[3, 5, 6])
        self.assertEqual(fwd, src)                     # nada inserido/removido
        self.assertEqual(len(fwd), len(src))

    def test_evidencia_primaria_e_byte_cru_nao_texto(self):
        src = NONMULT4
        res, fwd = replay_through_tap("cap-eb", src, read_chunks=[1000, 3099])
        # o SHA-256 e calculado sobre bytes crus; reencode do hexdump != evidencia
        self.assertEqual(res.evidence_sha256, _sha(src))
        # hexdump e secundario: cabe apenas 16 bytes head/tail
        self.assertLessEqual(len(bytes.fromhex(res.blocks[0].hexdump_head.replace(" ", ""))), 16)

    def test_sem_descarte_sem_duplicacao_offsets_contiguos(self):
        src = LONG[:500_000]
        res, fwd = replay_through_tap("cap-cd", src, read_chunks=[7777] * 60 + [999999])
        self.assertEqual(fwd, src)
        # soma dos n_bytes == total, offsets encadeiam sem sobreposicao nem furo
        self.assertEqual(sum(b.n_bytes for b in res.blocks), len(src))
        for i in range(1, len(res.blocks)):
            self.assertEqual(res.blocks[i].offset_start, res.blocks[i - 1].offset_end)

    def test_um_unico_destino_de_forward(self):
        # replay_through_tap tem UM leitor (drain) do pipe de saida — equivale
        # ao server_api.py sendo o unico consumidor de /tmp/fifo_qrng.
        src = INCREMENTAL[:1024]
        res, fwd = replay_through_tap("cap-1c", src, read_chunks=[256, 768])
        self.assertEqual(fwd, src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
