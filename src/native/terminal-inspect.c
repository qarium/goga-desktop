// Read-only macOS process identity helper. No environment/configuration, paths,
// shell commands or signals are accepted. Build per target architecture.
#include <libproc.h>
#include <sys/proc_info.h>
#include <unistd.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <limits.h>

#define MAX_PIDS 65536
struct record { struct proc_bsdinfo b; pid_t sid; };
static int same_birth(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b) {
    return a->pbi_pid == b->pbi_pid && a->pbi_ppid == b->pbi_ppid &&
        a->pbi_uid == b->pbi_uid && a->pbi_start_tvsec == b->pbi_start_tvsec &&
        a->pbi_start_tvusec == b->pbi_start_tvusec;
}
static int read_bsd(pid_t pid, struct proc_bsdinfo *b) {
    errno = 0;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, b, sizeof(*b)) == sizeof(*b)) return 1;
    return errno == ESRCH ? -1 : 0;
}
// Birth mode deliberately permits TTY/session transition during node-pty startup.
static int read_birth(pid_t pid, struct proc_bsdinfo *b) {
    struct proc_bsdinfo after;
    int first = read_bsd(pid, b);
    if (first != 1) return first;
    int second = read_bsd(pid, &after);
    if (second != 1) return second;
    return same_birth(b, &after) ? 1 : 0;
}
static int read_record(pid_t pid, struct record *r) {
    struct proc_bsdinfo after;
    int first = read_bsd(pid, &r->b);
    if (first != 1) return first;
    errno = 0; r->sid = getsid(pid);
    if (r->sid < 0) return errno == ESRCH ? -1 : 0;
    int second = read_bsd(pid, &after);
    if (second != 1) return second;
    errno = 0; pid_t sid_after = getsid(pid);
    if (sid_after < 0) return errno == ESRCH ? -1 : 0;
    int stable = same_birth(&r->b, &after) && r->b.e_tdev == after.e_tdev &&
        r->b.pbi_pgid == after.pbi_pgid && r->sid == sid_after;
    if (stable) r->b = after; // Use the latest observed stopped/zombie state.
    return stable;
}
static void print_birth_fields(const struct proc_bsdinfo *b) {
    printf("\"pid\":%u,\"ppid\":%u,\"uid\":%u,\"startSec\":%llu,\"startUsec\":%llu",
        b->pbi_pid, b->pbi_ppid, b->pbi_uid,
        (unsigned long long)b->pbi_start_tvsec, (unsigned long long)b->pbi_start_tvusec);
}
static void print_record(const struct record *r) {
    printf("{"); print_birth_fields(&r->b);
    printf(",\"pgid\":%u,\"sid\":%d,\"tty\":%u,\"status\":%u}",
        r->b.pbi_pgid, r->sid, r->b.e_tdev, r->b.pbi_status);
}
static int fail(void) { puts("{\"ok\":false}"); return 0; }
static int snapshot(pid_t pid) {
    struct record root;
    if (read_record(pid, &root) != 1 || root.b.e_tdev == UINT32_MAX) return fail();
    int needed = proc_listpids(PROC_TTY_ONLY, root.b.e_tdev, NULL, 0);
    if (needed <= 0 || needed > (MAX_PIDS - 1024) * (int)sizeof(pid_t)) return fail();
    int capacity = needed + 1024 * (int)sizeof(pid_t);
    pid_t *pids = calloc(1, (size_t)capacity);
    if (!pids) return fail();
    int bytes = proc_listpids(PROC_TTY_ONLY, root.b.e_tdev, pids, capacity);
    if (bytes <= 0 || bytes >= capacity || bytes % sizeof(pid_t)) { free(pids); return fail(); }
    printf("{\"ok\":true,\"root\":"); print_record(&root); printf(",\"members\":[");
    int first = 1, uncertain = 0;
    for (size_t i = 0; i < (size_t)bytes / sizeof(pid_t); i++) {
        if (pids[i] <= 0) continue;
        struct record member;
        int status = read_record(pids[i], &member);
        if (status == -1) continue;
        if (status != 1) { uncertain++; continue; }
        if (!first) printf(",");
        print_record(&member); first = 0;
    }
    struct record final;
    int stable = read_record(pid, &final) == 1 && same_birth(&root.b, &final.b) &&
        final.b.e_tdev == root.b.e_tdev && final.b.pbi_pgid == root.b.pbi_pgid && final.sid == root.sid;
    printf("],\"uncertain\":%d,\"stable\":%s}\n", uncertain, stable ? "true" : "false");
    free(pids); return 0;
}
int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "version") == 0) {
#if defined(__arm64__)
        puts("{\"version\":1,\"platform\":\"darwin\",\"arch\":\"arm64\"}");
#elif defined(__x86_64__)
        puts("{\"version\":1,\"platform\":\"darwin\",\"arch\":\"x64\"}");
#else
#error Unsupported terminal inspector architecture
#endif
        return 0;
    }
    if (argc != 3) return 2;
    for (const char *c = argv[2]; *c; c++) if (*c < '0' || *c > '9') return 2;
    errno = 0; char *end; long value = strtol(argv[2], &end, 10);
    if (errno || !*argv[2] || *end || value < 2 || value > INT32_MAX) return 2;
    pid_t pid = (pid_t)value;
    if (strcmp(argv[1], "birth") == 0) {
        struct proc_bsdinfo birth;
        if (read_birth(pid, &birth) != 1) return fail();
        printf("{"); print_birth_fields(&birth); puts("}"); return 0;
    }
    if (strcmp(argv[1], "root") == 0) {
        struct record root;
        if (read_record(pid, &root) != 1) return fail();
        print_record(&root); puts(""); return 0;
    }
    if (strcmp(argv[1], "snapshot") == 0) return snapshot(pid);
    return 2;
}
