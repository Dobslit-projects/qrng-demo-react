# NIST SP 800-90B service — imagem de STAGING (fase item 5).
#
# Roda a VERSÃO CONTROLADA de qrng-nist-api/nist_service.py (correções A–H já
# migradas — ver physical-layer/qrng-api/NIST_SERVICE_BASELINE.md) numa porta
# de staging separada, com DB / data dir / upload dir próprios (nunca os de
# produção). A suíte SP 800-90B real NÃO está na imagem: o assessment é um
# script FAKE determinístico (qrng_nist90b_fake.sh) só para exercitar
# fila/persistência/lifecycle. /health expõe environment=staging + commit.
#
# Contexto de build: raiz do repositório.
#   docker build -f staging/nist-staging/Dockerfile -t kapua-staging-nist:local .
FROM python:3.12-slim

ARG NIST_SERVICE_COMMIT=unknown
ARG NIST_SERVICE_BUILD_DATE=unknown
ENV NIST_SERVICE_COMMIT=${NIST_SERVICE_COMMIT} \
    NIST_SERVICE_BUILD_DATE=${NIST_SERVICE_BUILD_DATE} \
    NIST_SERVICE_ENV=staging \
    NIST_SERVICE_VERSION=1.1.0-staging-candidate \
    PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir \
      fastapi==0.115.6 \
      "uvicorn[standard]==0.34.0" \
      python-multipart==0.0.20

WORKDIR /app
COPY qrng-nist-api/nist_service.py /app/nist_service.py
COPY staging/nist-staging/qrng_nist90b_fake.sh /opt/nist-fake/qrng_nist90b_fake.sh
RUN chmod +x /opt/nist-fake/qrng_nist90b_fake.sh && mkdir -p /data /staging-data

ENV NIST_ENABLED=true \
    NIST_BIND_ADDR=0.0.0.0 \
    NIST_PORT=18092 \
    NIST_DB_PATH=/data/nist-staging.db \
    NIST_DATA_DIR=/staging-data \
    NIST_SUITE_DIR=/opt/nist-fake \
    NIST_SCRIPT=/opt/nist-fake/qrng_nist90b_fake.sh \
    NIST_ASSESSMENT_ENGINE=fake \
    NIST_ASSESSMENT_ENGINE_VERSION=staging-fake-1 \
    NIST_TEST_INTERVAL_SECONDS=3600 \
    NIST_TEST_TIMEOUT_SECONDS=120 \
    NIST_MIN_BYTES=256
# NOTA: NIST_UPLOAD_MAX_BYTES NÃO é fixado aqui. O default do código é 128 MiB
# (asserção em test_nist_service.py). O compose de staging o reduz para 1 MiB
# para que o teste "acima do limite" rode rápido no CI sem enviar 128 MiB.

EXPOSE 18092
HEALTHCHECK --interval=10s --timeout=5s --retries=6 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:18092/health',timeout=3).status==200 else 1)"

CMD ["python", "/app/nist_service.py"]
