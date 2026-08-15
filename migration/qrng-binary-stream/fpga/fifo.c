#include <unistd.h>
#include <fcntl.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdint.h>
#include <sys/mman.h>
#include <signal.h>
#include <errno.h>
#include <endian.h>

#define AXI_FIFO_ADDR   0x43C00000
#define AXI_FIFO_WINDOW 0x20000

static volatile int run = 1;

static void intHandler(int dummy) { (void)dummy; run = 0; }

/*
 * Write exactly len bytes to stdout.
 * Retries on EINTR. Returns -1 on EPIPE or any other write error.
 * Caller must not pass len == 0.
 */
static int write_all(const void *buf, size_t len)
{
    const unsigned char *p = (const unsigned char *)buf;
    while (len > 0) {
        ssize_t n = write(STDOUT_FILENO, p, len);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) return -1;
        p   += (size_t)n;
        len -= (size_t)n;
    }
    return 0;
}

int main(void)
{
    int           fd;
    unsigned int *axi_fifo;
    uint32_t      num, le;

    signal(SIGINT,  intHandler);
    signal(SIGTERM, intHandler);
    signal(SIGPIPE, SIG_IGN);   /* broken pipe detected via write_all() return */

    fd = open("/dev/mem", O_RDWR | O_SYNC);
    if (fd < 0) { perror("open /dev/mem"); return 1; }

    axi_fifo = mmap(NULL, AXI_FIFO_WINDOW,
                    PROT_READ | PROT_WRITE, MAP_SHARED, fd, AXI_FIFO_ADDR);
    if (axi_fifo == MAP_FAILED) { perror("mmap"); close(fd); return 1; }

    /* Diagnostics to stderr — never written to the binary stdout stream */
    fprintf(stderr, "ISR 0x0 = %x\n", *axi_fifo);
    *axi_fifo = 0xFFFFFFFF;
    fprintf(stderr, "ISR 0x0 = %x\n", *axi_fifo);
    *(axi_fifo + (0x18 / 0x4)) = 0xA5;  /* RDFR reset */

    while (run) {
        num = *(axi_fifo + (0x11000 / 0x4));   /* read from AXI FIFO */
        *axi_fifo = 0xFFFFFFFF;                 /* clear ISR */
        le = htole32(num);                      /* explicit little-endian, 4 bytes fixed */
        if (write_all(&le, sizeof(le)) != 0)
            break;                              /* stdout closed or EPIPE — exit cleanly */
    }

    munmap(axi_fifo, AXI_FIFO_WINDOW);
    close(fd);
    return 0;
}
