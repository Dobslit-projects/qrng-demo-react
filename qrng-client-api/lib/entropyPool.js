"use strict";
// Pool de pré-carga para a amostra rápida (2026-10-18).
//
// Por quê: o endpoint público limita 64 KiB por chamada, então o botão
// "Baixar dados QRNG" fazia 16 chamadas em sequência — cada uma com a ida e
// volta usuário → VM → túnel → broker em Recife (≈1,3–1,5 s medidos de fora).
// O broker entrega 1 MiB numa única chamada em ≈1,1 s; mantendo alguns MiB
// recém-chegados em memória, a amostra de 1 MiB sai da VM sem esperar o túnel.
//
// Regras invioláveis:
//   - cada byte é entregue NO MÁXIMO UMA VEZ (take() remove o que entrega);
//   - blocos mais velhos que maxAgeMs são descartados (não viram "amostra
//     antiga" servida como fresca — o resolver de proveniência também checa);
//   - só entram no pool blocos que o chamador classificou como aceitáveis
//     (fetchBlock decide; o servidor recusa blocos com alarme/gap/transporte ruim);
//   - nada é inventado: pool vazio => take() devolve null e o servidor busca direto.

class EntropyPool {
  /**
   * @param {object} o
   * @param {(n:number)=>Promise<{buf:Buffer, upHdr:object, discontinuous:boolean}>} o.fetchBlock
   * @param {number} [o.capacityBytes]  alvo de bytes guardados (0 desliga o pool)
   * @param {number} [o.blockBytes]     tamanho de cada busca no broker
   * @param {number} [o.maxAgeMs]       idade máxima de um bloco guardado
   * @param {()=>number} [o.now]
   */
  constructor(o) {
    this.fetchBlock = o.fetchBlock;
    this.capacityBytes = Math.max(0, o.capacityBytes ?? 2 * 1024 * 1024);
    this.blockBytes = Math.max(1, o.blockBytes ?? 1024 * 1024);
    this.maxAgeMs = o.maxAgeMs ?? 240000;
    this.now = o.now || Date.now;
    this.blocks = [];          // { buf, offset, upHdr, discontinuous, receivedAt }
    this.refilling = null;     // promessa da recarga em curso (single-flight)
    this.lastError = null;
    this.servedBytes = 0;
    this.discardedBytes = 0;
  }

  prune() {
    const limit = this.now() - this.maxAgeMs;
    while (this.blocks.length && this.blocks[0].receivedAt < limit) {
      const b = this.blocks.shift();
      this.discardedBytes += b.buf.length - b.offset;
    }
  }

  available() {
    this.prune();
    return this.blocks.reduce((s, b) => s + (b.buf.length - b.offset), 0);
  }

  /**
   * Retira exatamente n bytes (consome; nunca devolve os mesmos bytes duas vezes).
   * @returns {null | {buf:Buffer, blocks:Array<{upHdr:object, discontinuous:boolean, receivedAt:number}>}}
   */
  take(n) {
    if (!(n > 0) || this.available() < n) return null;
    const out = Buffer.allocUnsafe(n);
    const used = [];
    let filled = 0;
    while (filled < n) {
      const b = this.blocks[0];
      const k = Math.min(n - filled, b.buf.length - b.offset);
      b.buf.copy(out, filled, b.offset, b.offset + k);
      b.offset += k;
      filled += k;
      used.push({ upHdr: b.upHdr, discontinuous: b.discontinuous, receivedAt: b.receivedAt });
      if (b.offset >= b.buf.length) this.blocks.shift();
    }
    this.servedBytes += n;
    return { buf: out, blocks: used };
  }

  /** Completa o pool até capacityBytes. Uma recarga por vez; erros param a recarga. */
  refill() {
    if (this.capacityBytes === 0) return Promise.resolve();
    if (this.refilling) return this.refilling;
    this.refilling = (async () => {
      try {
        while (this.available() < this.capacityBytes) {
          const blk = await this.fetchBlock(this.blockBytes);
          if (!blk || !blk.buf || blk.buf.length === 0) break;      // bloco recusado: tenta na próxima rodada
          this.blocks.push({ buf: blk.buf, offset: 0, upHdr: blk.upHdr || {}, discontinuous: !!blk.discontinuous, receivedAt: this.now() });
          this.lastError = null;
        }
      } catch (e) {
        this.lastError = e && e.message ? e.message : String(e);
      } finally {
        this.refilling = null;
      }
    })();
    return this.refilling;
  }

  stats() {
    const avail = this.available();
    return {
      available_bytes: avail,
      capacity_bytes: this.capacityBytes,
      oldest_age_ms: this.blocks.length ? this.now() - this.blocks[0].receivedAt : null,
      served_bytes: this.servedBytes,
      discarded_bytes: this.discardedBytes,
      last_error: this.lastError,
    };
  }
}

module.exports = { EntropyPool };
