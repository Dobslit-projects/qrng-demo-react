#include <unistd.h>
#include <fcntl.h>
#include <stdlib.h>
#include <stdio.h>
#include <sys/mman.h>
#include <signal.h>

#define AXI_FIFO_ADDR 0x43C00000
#define AXI_FIFO_WINDOW 0x20000
#define COUNT 1000000ULL

static volatile int run = 1;

void intHandler(int dummy) {
    run = 0;
}

// Incrementos de endereço sao multiplos de sizeof(unsigned int)

int main (void) {
	int fd;
	FILE *store;
	unsigned int *axi_fifo;
	unsigned int num, isr, rdfo;
	unsigned int num_vector[COUNT];

	signal(SIGINT, intHandler);
	fd = open( "/dev/mem", O_RDWR | O_SYNC );
	//store = fopen( "numbers_qrng.txt", "w+a" );
        store = fopen ( "/dev/stdout", "wb");
	if (!store) {
		printf("Error opening file!\n");
		return 1;
	}
	
	axi_fifo = mmap( NULL,
					AXI_FIFO_WINDOW,
					PROT_READ | PROT_WRITE,
					MAP_SHARED,
					fd,
					AXI_FIFO_ADDR );
					
					
	printf( "ISR 0x0 = %x\n", *axi_fifo );
	*axi_fifo = 0xFFFFFFFF;
	printf( "ISR 0x0 = %x\n", *axi_fifo );
	
	// Precisamos resetar o bloco com este registro antes de ler
	*( axi_fifo + (0x18/0x4) ) = 0xA5; // RDFR
	
	/*for ( unsigned long long i = 0; i < COUNT; i ++ )*/ while ( run ) {
		num = *( axi_fifo + (0x11000/0x4) ); // Endereço de leitura do FIFO
		//isr =  *( axi_fifo + (0x00/0x4) );
		*axi_fifo = 0xFFFFFFFF;
		//rdfo = *( axi_fifo + (0x1c/0x4) );
		//num_vector[i] = *( axi_fifo + (0x11000/0x4) );
		//fprintf( store, "0x%08x\n", num );
		fprintf( store, "%u", num );
		//printf("test\n");
		//sleep(1);
		//printf( "ISR 0x%08x; RDFO 0x%08x; RDFD: 0x%08x\n", isr, rdfo, num );
	}
	
	munmap( axi_fifo, AXI_FIFO_WINDOW );
	close( fd );
	fclose( store );
	return 0;
}
