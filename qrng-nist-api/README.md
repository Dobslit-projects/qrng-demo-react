# QRNG NIST SP 800-90B Validation Service

Microserviço Python/FastAPI que roda na VM de Recife (`dobslit@192.168.0.224`) e expõe endpoints HTTP para executar a suíte NIST SP 800-90B de forma periódica e sob demanda.

## Pré-requisitos

- Python 3.x com FastAPI + uvicorn instalados (já presentes em `/home/dobslit/qrng-api/venv`)
- Suíte NIST compilada em `/home/dobslit/SP800-90B_EntropyAssessment/cpp`
- `python-multipart` instalado no venv

```bash
/home/dobslit/qrng-api/venv/bin/pip install python-multipart
```

## Configuração (.env / systemd Environment=)

| Variável                     | Padrão                                                   | Descrição                              |
|------------------------------|----------------------------------------------------------|----------------------------------------|
| `NIST_ENABLED`               | `true`                                                   | Liga/desliga integração                |
| `NIST_SUITE_DIR`             | `/home/dobslit/SP800-90B_EntropyAssessment/cpp`          | Diretório com ea_iid / ea_non_iid      |
| `NIST_SCRIPT`                | `…/cpp/qrng_nist90b.sh`                                  | Caminho absoluto do script wrapper     |
| `NIST_DATA_DIR`              | `/home/dobslit/qrng_data_nist`                           | Onde buscar arquivos para teste periódico |
| `NIST_TEST_INTERVAL_SECONDS` | `300`                                                    | Intervalo entre testes automáticos     |
| `NIST_TEST_TIMEOUT_SECONDS`  | `1800`                                                   | Timeout máximo por job                 |
| `NIST_MAX_UPLOAD_MB`         | `200`                                                    | Limite de tamanho de upload            |
| `NIST_DB_PATH`               | `/home/dobslit/qrng-nist-api/nist.db`                   | Banco SQLite de jobs                   |

## Rodar manualmente

```bash
cd /home/dobslit/qrng-nist-api
/home/dobslit/qrng-api/venv/bin/python nist_service.py
```

## Endpoints

| Método | Path                    | Descrição                              |
|--------|-------------------------|----------------------------------------|
| GET    | `/health`               | Liveness check                         |
| GET    | `/nist/status`          | Config, último job, próximo periódico  |
| GET    | `/nist/jobs`            | Histórico de jobs                      |
| GET    | `/nist/jobs/:id`        | Detalhes de um job                     |
| GET    | `/nist/jobs/:id/log`    | stdout + stderr completos              |
| POST   | `/nist/run`             | Teste sob demanda (arquivo existente)  |
| POST   | `/nist/upload`          | Upload + teste imediato                |

## Interpretar resultados

- **H_original**: entropia por símbolo (bits), via IID e non-IID
- **H_bitstring**: entropia por bit da representação binária
- **min(H_original, 8×H_bitstring)**: estimativa conservadora (valor reportado como entropia mínima garantida)
- **IID passou**: se chi-square + LRS + permutation passaram
- **Estimador limitante**: estimador com menor entropia encontrado no teste non-IID

Um QRNG de boa qualidade deve apresentar H_original próximo de 8 bits/símbolo (máximo teórico para 8 bits por símbolo).
