# NIST SP 800-90B service — imagem de STAGING com a SUÍTE REAL (fase item 7).
#
# Roda a versão CONTROLADA de qrng-nist-api/nist_service.py contra a suíte
# SP 800-90B REAL (usnistgov/SP800-90B_EntropyAssessment), compilada de fonte
# no build. Isolada de produção: porta 18093, DB/data/upload próprios,
# NIST_ASSESSMENT_ENGINE=sp800-90b-reference, synthetic_result=false.
#
# NÃO substitui o processo produtivo (:8002). É para a comparação paralela
# produção × staging-real descrita em NIST_STAGING_REAL.md.
#
# Fonte da suíte:
#   repo   : https://github.com/usnistgov/SP800-90B_EntropyAssessment
#   commit : 87c104d0ed4cbc96103e7b8b38d6f2c7e0a6b289  (2026-05-26, PR #248)
#   flags  : g++ -std=c++11 -fopenmp -O2 -ffloat-store -I/usr/include/jsoncpp
#            (SEM -march=native -> binário reproduzível entre hosts; o host
#             dobslit compila COM -march=native, então os hashes divergem por
#             design — ver NIST_STAGING_REAL.md "reprodutibilidade").
#   libs   : -lbz2 -lpthread -ldivsufsort -ldivsufsort64 -ljsoncpp -lcrypto
#            (+ -lmpfr -lgmp para ea_conditioning)
#
# Contexto de build: raiz do repositório.
#   docker build -f staging/nist-staging-real/Dockerfile -t kapua-staging-nist-real:local .

# ---- estágio 1: compila a suíte real ----
FROM debian:bookworm-slim AS suite
ARG SP90B_COMMIT=87c104d0ed4cbc96103e7b8b38d6f2c7e0a6b289
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates g++ make \
      libbz2-dev libdivsufsort-dev libjsoncpp-dev libssl-dev libmpfr-dev libgmp-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/sp90b
RUN git clone https://github.com/usnistgov/SP800-90B_EntropyAssessment.git . \
    && git checkout "${SP90B_COMMIT}" \
    && git rev-parse HEAD > /opt/sp90b/COMMIT.txt
# build sem -march=native (reprodutível); registra os hashes resultantes
RUN cd cpp \
    && sed -i 's/ -march=native//' Makefile \
    && make iid non_iid restart 2>&1 | tail -20 \
    && sha256sum ea_iid ea_non_iid ea_restart > /opt/sp90b/BINARY_SHA256.txt \
    && cat /opt/sp90b/BINARY_SHA256.txt

# ---- estágio 2: serviço ----
FROM python:3.12-slim
ARG NIST_SERVICE_COMMIT=unknown
ARG NIST_SERVICE_BUILD_DATE=unknown
ENV NIST_SERVICE_COMMIT=${NIST_SERVICE_COMMIT} \
    NIST_SERVICE_BUILD_DATE=${NIST_SERVICE_BUILD_DATE} \
    NIST_SERVICE_ENV=staging \
    NIST_SERVICE_VERSION=1.1.0-staging-candidate \
    NIST_ASSESSMENT_ENGINE=sp800-90b-reference \
    NIST_ASSESSMENT_ENGINE_VERSION=87c104d0 \
    PYTHONUNBUFFERED=1

# libs de runtime da suíte + python-multipart
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash file libbz2-1.0 libdivsufsort3 libjsoncpp25 libssl3 libmpfr6 libgmp10 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir fastapi==0.115.6 "uvicorn[standard]==0.34.0" python-multipart==0.0.20

COPY --from=suite /opt/sp90b /opt/sp90b
COPY qrng-nist-api/nist_service.py /app/nist_service.py
RUN mkdir -p /data /staging-data

ENV NIST_ENABLED=true \
    NIST_BIND_ADDR=0.0.0.0 \
    NIST_PORT=18093 \
    NIST_DB_PATH=/data/nist-staging-real.db \
    NIST_DATA_DIR=/staging-data \
    NIST_SUITE_DIR=/opt/sp90b/cpp \
    NIST_SCRIPT=/opt/sp90b/cpp/qrng_nist90b.sh \
    NIST_TEST_INTERVAL_SECONDS=3600 \
    NIST_TEST_TIMEOUT_SECONDS=1800 \
    NIST_MIN_BYTES=1000000

WORKDIR /app
EXPOSE 18093
HEALTHCHECK --interval=15s --timeout=5s --retries=6 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:18093/health',timeout=3).status==200 else 1)"
CMD ["python", "/app/nist_service.py"]
