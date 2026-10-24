// Unit fixture: compile the production reader with deterministic OS calls.
#define proc_pidinfo fixture_pidinfo
#define proc_listpids fixture_listpids
#define getsid fixture_getsid
#define main inspector_main
#include "../../src/native/terminal-inspect.c"
#undef main
#define assert(condition) do { if (!(condition)) { fprintf(stderr, "Assertion failed at line %d\n", __LINE__); exit(1); } } while (0)

static int reads = 0, change = 0;
int fixture_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size) {
    (void)flavor; (void)arg; assert(size == sizeof(struct proc_bsdinfo));
    struct proc_bsdinfo b = {0};
    b.pbi_pid = (uint32_t)pid; b.pbi_ppid = 100; b.pbi_uid = 501;
    b.pbi_pgid = (uint32_t)pid; b.e_tdev = 30; b.pbi_status = 2;
    b.pbi_start_tvsec = 1000; b.pbi_start_tvusec = 2;
    reads++;
    if (reads % 2 == 0) {
        if (change == 1) b.e_tdev++;
        if (change == 2) b.pbi_uid++;
        if (change == 3) b.pbi_ppid++;
        if (change == 4) b.pbi_start_tvusec++;
        if (change == 5) b.pbi_status = 4;
        if (change == 6) b.pbi_pgid++;
    }
    memcpy(buffer, &b, sizeof(b)); return (int)sizeof(b);
}
pid_t fixture_getsid(pid_t pid) { return pid; }
int fixture_listpids(uint32_t type, uint32_t info, void *buffer, int size) {
    (void)type; (void)info; (void)buffer; (void)size;
    return MAX_PIDS * (int)sizeof(pid_t); // too large: fail closed before allocation/output
}
int main(int argc, char **argv) {
    fputs("fixture-entered\n", stderr);
    assert(argc == 2);
    struct proc_bsdinfo b;
    struct record r;
    if (strcmp(argv[1], "birth-transition") == 0) {
        change = 1; assert(read_birth(200, &b) == 1);
    } else if (strcmp(argv[1], "identity-changes") == 0) {
        for (change = 2; change <= 4; change++) { reads = 0; assert(read_birth(200, &b) == 0); }
    } else if (strcmp(argv[1], "terminal-changes") == 0) {
        change = 1; assert(read_record(200, &r) == 0);
        reads = 0; change = 6; assert(read_record(200, &r) == 0);
    } else if (strcmp(argv[1], "latest-status") == 0) {
        change = 5; assert(read_record(200, &r) == 1); assert(r.b.pbi_status == 4);
    } else if (strcmp(argv[1], "invalid-arguments") == 0) {
        const char *bad[] = {"0", "1", "-200", "200;echo", "2147483648", "2.5", "", " 200"};
        for (size_t i = 0; i < sizeof(bad)/sizeof(*bad); i++) {
            char *args[] = {"inspect", "birth", (char *)bad[i]};
            assert(inspector_main(3, args) == 2);
        }
        assert(reads == 0);
    } else if (strcmp(argv[1], "snapshot-bound") == 0) {
        assert(snapshot(200) == 0);
    } else return 2;
    return 0;
}
