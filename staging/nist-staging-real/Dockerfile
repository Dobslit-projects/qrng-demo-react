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
# Imagem de estágio ÚNICO: as ferramentas de build ficam na imagem (~200 MB a
# mais) para evitar o casamento frágil de nomes de pacotes runtime entre
# releases do Debian. É staging, não produção.
#
# Contexto de build: raiz do repositório.
#   docker build -f staging/nist-staging-real/Dockerfile -t kapua-staging-nist-real:local .
FROM python:3.12-slim

ARG SP90B_COMMIT=87c104d0ed4cbc96103e7b8b38d6f2c7e0a6b289
ARG NIST_SERVICE_COMMIT=unknown
ARG NIST_SERVICE_BUILD_DATE=unknown
ENV NIST_SERVICE_COMMIT=${NIST_SERVICE_COMMIT} \
    NIST_SERVICE_BUILD_DATE=${NIST_SERVICE_BUILD_DATE} \
    NIST_SERVICE_ENV=staging \
    NIST_SERVICE_VERSION=1.1.0-staging-candidate \
    NIST_ASSESSMENT_ENGINE=sp800-90b-reference \
    NIST_ASSESSMENT_ENGINE_VERSION=87c104d0 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates bash file g++ make \
      libbz2-dev libdivsufsort-dev libjsoncpp-dev libssl-dev libmpfr-dev libgmp-dev \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir fastapi==0.115.6 "uvicorn[standard]==0.34.0" python-multipart==0.0.20

# ---- compila a suíte real do commit fixado ----
WORKDIR /opt/sp90b
RUN git clone https://github.com/usnistgov/SP800-90B_EntropyAssessment.git . \
    && git checkout "${SP90B_COMMIT}" \
    && git rev-parse HEAD > /opt/sp90b/COMMIT.txt \
    && cd cpp \
    && sed -i 's/ -march=native//' Makefile \
    && make iid non_iid restart 2>&1 | tail -20 \
    && test -x ./ea_iid && test -x ./ea_non_iid \
    && sha256sum ea_iid ea_non_iid ea_restart > /opt/sp90b/BINARY_SHA256.txt \
    && cat /opt/sp90b/COMMIT.txt /opt/sp90b/BINARY_SHA256.txt

# wrapper local da Dobslit (NÃO é do repo upstream) — cópia byte-a-byte do que
# roda em produção: /home/dobslit/SP800-90B_EntropyAssessment/cpp/qrng_nist90b.sh
# sha256 aaec3c3e8e8faa3e8169c77711c972b124bdecb0541ff283a5894b3ea60fc498
COPY staging/nist-staging-real/qrng_nist90b.sh /opt/sp90b/cpp/qrng_nist90b.sh
RUN chmod +x /opt/sp90b/cpp/qrng_nist90b.sh \
    && sha256sum /opt/sp90b/cpp/qrng_nist90b.sh

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
