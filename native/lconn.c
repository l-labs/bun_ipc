// lconn.c — IPC (Inter-Process Communication) client for the L database.       //
// Speaks the L wire protocol over TCP: nx sizes a K object (the universal      //
// boxed value of the L type system), b0/b9 serialize it into a length-         //
// prefixed frame, snd/rcv move frames over the socket, and d0/d9               //
// deserialize the reply (inflating LZ4-compressed payloads first).  The        //
// one/two-letter names (r0/r1, ktn, kj, ...) are the historical core           //
// vocabulary of the K object model; the l_* functions at the bottom wrap       //
// them in the fully-named FFI-friendly API declared in l_interface.h.          //
#ifdef MAC                                                                      // historical Mac build: __thread elided, thread-locals are plain
#define __thread                                                                // statics (client is used from a single thread per handle)
#endif                                                                          //
#ifndef _GNU_SOURCE                                                             // (build scripts may predefine it)
#define _GNU_SOURCE                                                             // glibc: expose gethostbyaddr and friends
#endif                                                                          //
#define _POSIX_C_SOURCE 200112L                                                 // POSIX.1-2001 socket/pthread interfaces
#ifndef __USE_XOPEN2K                                                           //
#define __USE_XOPEN2K                                                           // older glibc: needed for struct addrinfo visibility
#endif                                                                          //
#ifdef __cplusplus                                                              //
extern "C" {                                                                    // this is a C ABI (Application Binary Interface) library
#endif                                                                          //
#include<pthread.h>                                                             // mutexes guard the symbol intern table (sn/ss)
#include<stdlib.h>                                                              // malloc/free/exit for the buddy allocator backing store
#include<stdint.h>                                                              // exact-width ints for the l_* FFI signatures
#include<string.h>                                                              // strlen/strcpy/memcpy for symbol + payload copies
#include<stdio.h>                                                               // printf: l_debug_print and the intern-full fatal path
#include<stdarg.h>                                                              // va_list: k()/knk() variadic argument walking
#include<stdbool.h>                                                             // bool returns in the l_is_* predicate API
#include<unistd.h>                                                              // close(): was implicitly declared before this rework
#include<errno.h>                                                               // qbl/qip classify EWOULDBLOCK/EINPROGRESS socket states
#include<fcntl.h>                                                               // FD_CLOEXEC: sockets must not leak across exec()
#include<signal.h>                                                              // SIGPIPE ignored so a dead peer surfaces as send()==-1
#include<sys/types.h>                                                           //
#include<sys/socket.h>                                                          //
#include<netinet/in.h>                                                          // sockaddr_in for connect/bind/accept
#include<netinet/tcp.h>                                                         // TCP_NODELAY: queries are latency-sensitive
#include<arpa/inet.h>                                                           // inet_addr/inet_ntoa dotted-quad conversion
#include<netdb.h>                                                               // gethostbyname/gethostbyaddr DNS lookup
// ── house macro legend ─────────────────────────────────────────────────────  //
//   Z=static  R=return  SW=switch  CS(n,x)=case n:x;break  CD=default          //
//   DO(n,x)=for i in [0,n) run x   P(x,y)=guard: if(x) return y                //
//   U(x)=P(!(x),0) null-guard      iN=__inline                                 //
//   ZI/ZK/ZV/ZS/ZG = static int/K/void/char*/byte function                     //
#define Z static                                                                //
#define R return                                                                //
#define SW switch                                                               //
#define CS(n,x) case n:x;break;                                                 //
#define CD default                                                              //
#define DO(n,x) {I i=0,_n=(n);for(;i<_n;++i){x;}}                               //
#define P(x,y) {if(x)R(y);}                                                     //
#define U(x) P(!(x),0)                                                          //
#define iN __inline                                                             //
// ── single-letter types (K object model vocabulary) ────────────────────────  //
typedef char*S,C;                                                               // S=string (char*), C=char
typedef unsigned char G;                                                        // G=byte
typedef short H;                                                                // H=halfword (16-bit)
typedef int I;                                                                  // I=int (32-bit)
typedef long long J;                                                            // J=long (64-bit)
typedef float E;                                                                // E=real (32-bit float)
typedef double F;                                                               // F=float (64-bit double)
typedef void V;                                                                 // V=void
typedef unsigned int UI;                                                        // UI=unsigned int
typedef unsigned long long UJ;                                                  // UJ=unsigned 64-bit
typedef unsigned long L;                                                        // L=machine word (pthread ids)
typedef struct k{I r;H t,u;I n;unsigned char G[1];}*K;                          // r=refcount t=type u=attr n=count G=payload
#define ZI Z I                                                                  //
#define ZK Z K                                                                  //
#define ZV Z V                                                                  //
#define ZS Z S                                                                  //
#define ZG Z G                                                                  //
// ── wire type tags (positive=vector, negative=atom of that type) ───────────  //
#define KB 1                                                                    // boolean
#define KG 4                                                                    // byte
#define KH 5                                                                    // short
#define KI 6                                                                    // int
#define KJ 7                                                                    // long
#define KE 8                                                                    // real (f32)
#define KF 9                                                                    // float (f64)
#define KC 10                                                                   // char
#define KS 11                                                                   // symbol (interned char*)
#define KP 12                                                                   // timestamp (ns since 2000.01.01)
#define KD 14                                                                   // date (days since 2000.01.01)
#define KZ 15                                                                   // datetime (fractional days)
#define KT 19                                                                   // time (ms)
#define XE 20                                                                   // first enum type; 20..76 are enums, 77+t mapped lists
#define XT 98                                                                   // table (atom wrapping a column dict)
#define XD 99                                                                   // dict (2-list: keys, values)
#define XX 100                                                                  // lambda; XX+1..3 primitives, XX+4.. projections/adverbs
// ── payload accessors ───────────────────────────────────────────────────────
#define kG(x) ((x)->G)                                                          // byte vector data
#define kC(x) kG(x)                                                             // char vector data
#define kH(x) ((H*)kG(x))                                                       // short vector data
#define kI(x) ((I*)kG(x))                                                       // int vector data
#define kJ(x) ((J*)kG(x))                                                       // long vector data
#define kE(x) ((E*)kG(x))                                                       // real vector data
#define kF(x) ((F*)kG(x))                                                       // float vector data
#define kS(x) ((S*)kG(x))                                                       // symbol vector data
#define kK(x) ((K*)kG(x))                                                       // K object vector data
#define TX(T,x) (*(T*)((G*)(x)+8))                                              // atom payload: 8 bytes past the header
#define xt x->t                                                                 // conventional accessors for the variable named x
#define xn x->n                                                                 //
#define xi TX(I,x)                                                              //
#define xG x->G                                                                 //
#define xK ((K*)xG)                                                             //
// ── tunables and global state ───────────────────────────────────────────────
#define CN 3                                                                    // number of critical-section mutexes (slot 1 = intern table)
#define MN 33                                                                   // buddy allocator bucket count (16B..16B<<32)
#define AC 256                                                                  // atom free-cache capacity (16-byte headers recycled hot)
#define BIGBLOB 22                                                              // minimum backing-store bucket actually malloc'd
I m,AF;                                                                         // m=multithreaded flag (locks live), AF=host endianness byte
J M2;                                                                           // M2=heap limit in bytes (0 = unlimited)
Z L id;                                                                         // pthread id of the initialising thread (diagnostic only)
S __thread es;                                                                  // es=error string set by krr(), consumed by ee()
S const ES[]={"nyi","type","length","rank","open\"","open[","value",            // canonical
 "parse","stack","cond","attr","access","mismatch","domain","splay",            // error
 "limit","timeout"};                                                            // strings, indexed by the protocol error codes
Z J __thread M0,M1,M3;                                                          // M0=bytes in use, M1=bytes mapped, M3=hidden bytes
Z V __thread*MI[MN],*M9;                                                        // MI=per-bucket free lists, M9=deferred free chain
Z J MZ[MN]={16,0,0,0,0,0,8,0,0,0,0,0,0,0,0,8};                                  // bucket byte sizes; mi0 folds
Z K __thread ac[AC];ZI __thread acn=0;                                          // ac=atom cache, acn=cached count
Z S*hh;Z UI hj=1;                                                               // hh=symbol intern hash table, hj=its size-1 mask
K*kp1,*kp2,*kp3,K0,K9;                                                          // primitive singletons, empty list, generic null
// ── forward declarations (the internal API index of this file) ─────────────  //
V r0(K);K r1(K);                                                                // release / retain (refcount is zero-based: 0 = one ref)
G*m1(J);ZV m0(V*);V m9(V);                                                      // allocate / free / drain deferred frees
V*krr(S);S ss(S),sn(S,I);                                                       // set error; intern nul/len-delimited symbol
K ktn(I,I),ktg(I,I),knk(I,...),ktk(I,K),k_(S);                                  // vector/atom constructors
G*dsn(V*,V*,I);                                                                 // byte copy returning the advanced destination
I cls(I);V ext0(I),mi0(V);I qt(K);                                              // close fd; exit; lazy init; keyed-table?
I rcv(I,V*,I),snd(I,V*,I);                                                      // socket receive/send (khpu handshakes before their definitions)
// ── tiny inline helpers ─────────────────────────────────────────────────────
iN ZI vt(I t){R t<0?-t:t;}                                                      // vt. absolute value of a type tag
iN ZK rxy(K*k,K y){R r0(*k),y;}                                                 // rxy. release *k, pass y through (swap idiom)
iN ZI q6(I t){R !t||t==XX+4||t==XX+5;}                                          // q6. holds child K pointers? (mixed
// list, projection XX+4, composition XX+5 — their payloads recurse)            //
#ifdef __aarch64__                                                              //
#define inc(x) __sync_add_and_fetch(x,1)                                        // atomic refcount ++ on ARM
#define dec(x) __sync_sub_and_fetch(x,1)                                        // atomic refcount -- on ARM
#else                                                                           // x86: historical inline-assembly lock inc/dec (read-back non-atomic)
#define inc(x) ({__asm__ __volatile__("lock;incl %0":"=m"(*x):"m"(*x));*x;})    //
#define dec(x) ({__asm__ __volatile__("lock;decl %0":"=m"(*x):"m"(*x));*x;})    //
#endif                                                                          //
// ── POSIX shims ─────────────────────────────────────────────────────────────
ZS sr0(V){R strerror(errno);}                                                   // sr0. current errno as text (for orr)
ZI exe(I d){R fcntl(d,F_SETFD,FD_CLOEXEC)?-1:d;}                                // exe. mark close-on-exec
ZI qbl(V){R errno==EWOULDBLOCK;}                                                // qbl. would-block? (partial send/recv)
ZI qip(V){R errno==EINPROGRESS;}                                                // qip. connect still in progress?
I cls(I d){R close(d);}                                                         // cls. close a socket descriptor
V ext0(I i){exit(i);}                                                           // ext0. process exit (intern-table-full fatal path)
ZV wsa(V){Z struct sigaction s;s.sa_handler=SIG_IGN;sigaction(SIGPIPE,&s,0);}   // ignore SIGPIPE: broken peer must return -1, not kill the process
// ── locks and threads ───────────────────────────────────────────────────────
Z pthread_attr_t p;Z pthread_mutex_t cs[CN];Z pthread_mutexattr_t mattr;        //
iN ZV c1(I i){if(m)pthread_mutex_lock(cs+i);}                                   // c1. lock section i (if MT)
iN ZV c0(I i){if(m)pthread_mutex_unlock(cs+i);}                                 // c0. unlock section i
ZV c2(V){pthread_mutexattr_init(&mattr);                                        // c2. init recursive mutexes: sn()
 pthread_mutexattr_settype(&mattr,PTHREAD_MUTEX_RECURSIVE);                     // may re-enter
 DO(CN,pthread_mutex_init(cs+i,&mattr))pthread_attr_init(&p);                   // via _sn grow
 pthread_attr_setdetachstate(&p,PTHREAD_CREATE_DETACHED);}                      // workers detach
Z L t9(V){R(L)pthread_self();}                                                  // t9. current thread id
L t1(V*(*f)(V*),V*v){pthread_t t;R pthread_create(&t,&p,f,v),(L)t;}             // t1. spawn detached thread running f(v); returns its id
// ── buddy allocator ─────────────────────────────────────────────────────────
// Blocks carry their bucket index in the byte at offset -8; refcounted K       //
// objects additionally read x->G[-16] (255 = foreign/mapped memory).           //
ZG*m8(J n){R(G*)m1(n-8)-8;}                                                     // m8. raw block: n bytes including the 8B header
ZV m0(V*a){I i=((C*)a)[-8];M0-=16l<<i;*(V**)a=MI[i];MI[i]=a;}                   // m0. free: push block onto its bucket's free list (no coalescing)
G*m1(J n){G*a,*b;UI i,j;J k;                                                    // m1. allocate n payload bytes (+8B header)
 if(n+8<=16)i=0;                                                                // smallest bucket holds one atom
 else{i=(UI)(64-__builtin_clzll((UJ)(n+8)-1))-4;if(i>=MN)i=MN-1;}               // ceil log2
 if((a=MI[i]))R MI[i]=*(V**)a,M0+=16l<<i,a;                                     // exact-fit free block: pop it
 for(j=i;++j<MN;)if((a=MI[j])){                                                 // else split the nearest larger free block
  for(MI[j]=*(V**)a,a[-8]=(G)i;i<j;)b=a+MZ[--j],MI[b[-8]=(G)j]=b,*(G**)b=0;     // halve down to size i, parking each buddy half on its free list
  R M0+=16l<<i,a;}                                                              //
 if((k=MZ[i=BIGBLOB>i?BIGBLOB:i],(M2&&M2<M1+k)||                                // grow: at least BIGBLOB;
  !(a=(I)sizeof(K)==4&&i>27?0:malloc(8+(L)k))))m9();                            // over limit/OOM: drain
 *(G**)a=M9,M9=a;                                                               // chain backing block for m9 reclamation
 a+=8,M1+=MZ[i],M0+=16l<<i;                                                     // account mapped + in-use bytes
 R*a=(G)i,m0(a+8),m1(n);}                                                       // stamp bucket, seed free list, retry
V m9(V){V*v;for(;(v=M9);free(v))M9=*(G**)v;}                                    // m9. free all backing blocks
V m3(J n){M3+=n;}                                                               // m3. account hidden (externally tracked) bytes
K m2(V){K x=ktn(KJ,4);                                                          // m2. memory stats as a 4-long vector
 R kJ(x)[0]=M0,kJ(x)[1]=M1,kJ(x)[2]=M2,kJ(x)[3]=M3,x;}                          // in-use/mapped/limit/hidden
// ── type metrics ────────────────────────────────────────────────────────────
J nt(UI t){Z I const n[]={(I)sizeof(K),1,0,0,1,2,4,8,4,8,1,(I)sizeof(K),        // nt.
 8,4,4,8,8,4,4,4};                                                              // element byte width per type tag
 R t<XE?n[t]:t<77?4:(I)sizeof(K);}                                              // enums are 4B indices; mapped hold K
I bt(UI t){Z I const b[]={0,4,0,0,4,5,6,7,8,9,4,11,7,6,6,9,7,6,6,6};            // bt.
 R t<XE?b[t]:t<77?6:XT;}                                                        // base storage type of a (possibly temporal) tag
// ── symbol interning ────────────────────────────────────────────────────────
I hC(G*a,UI n){I h=5381;DO(n,h=33*(h^a[i]))R h;}                                // hC. djb2-style byte hash
Z S _sn(C*a,I n){Z UI j;S*b=hh,s;I h=hC((G*)a,(UI)n);                           // _sn. intern n bytes;
// j counts 2 per live symbol so the table doubles at 50% load                  //
 for(;(s=b[h&hj]);++h){DO(n,if(s[i]!=a[i])goto L0)if(!s[n])R s;L0:;}            // probe: existing symbol must match all n bytes and be exactly n long
 P(j<=hj,(j+=2,s=malloc(4+n+1),*(I*)s=-1,*dsn(s+=4,a,n)=0,b[h&hj]=s))           // room: copy into a fresh cell (4B refcount slot, then NUL-terminated text)
 hj=2*(1+hj);if(!hj)printf("snfull\n"),m9(),ext0(1);                            // grow; wrap = fatal
 hh=(S*)malloc((L)(I)sizeof(K)*hj);DO(hj--,hh[i]=0)                             // new table; hj -> mask
 DO(j,if((s=b[i])){for(h=hC((G*)s,(UI)strlen(s));hh[h&hj];++h);hh[h&hj]=s;})    // rehash every live symbol into the doubled table
 R free(b),_sn(a,n);}                                                           // retry the insert in the grown table
S sn(S s,I n){R c1(1),s=_sn(s,n),c0(1),s;}                                      // sn. intern under the mutex
S ss(S s){R sn(s,(I)strlen(s));}                                                // ss. intern a NUL-terminated symbol
// ── embedded-server hooks (inert in this client-only build) ─────────────────
ZI lk(S s,S t){R 0;}                                                            // lk. hostname ACL match — client: never restricts
ZK U0(K x){R x;}                                                                // U0. attribute-index teardown — client: nothing to drop
ZV clr(V){es=0;}                                                                // clr. clear the pending error string
ZV mux(K x){}                                                                   // mux. release mapped memory — client never maps files
ZK vk(K x){R x;}                                                                // vk. re-key a freshly read mixed list — identity here
ZK dval(S s,K x){R x;}                                                          // dval. bind lambda s to body x — client keeps body
ZK val(K x){R 0;}                                                               // val. local eval of a parse tree — unsupported (handle 0)
ZK ve(K x){R 0;}                                                                // ve. inflate an enum vector — client never sends enums
ZK kv(K x){R x;}                                                                // kv. unmap a mapped list — client never maps
ZK uy(I u,K y){R y->u=u,r1(y);}                                                 // uy. stamp attribute u (sorted/unique/...)
// ── reference counting ──────────────────────────────────────────────────────
V r0(K x){if(x->r){m?dec(&x->r):--x->r;R;}                                      // r0. release: shared? just --
 if(xt<0){L0:if(acn<AC){ac[acn++]=x;M0-=16;R;}m0(xG-8);R;}                      // dead atom: park in the atom cache for hot reuse, else free the 16B block
 if(q6(xt)||xt==XD||xt==XX){DO(xn,if(xK[i])r0(xK[i]))m0(xG-8);R;}               // container: release each child (deserialize may leave NULL holes)
 if(xt>=XT){if(xt==XT||(UI)(xt-(XX+6))<6)r0(TX(K,x));goto L0;}                  // table and adverb-derived forms wrap one child; then free as an atom
 if(x->u>4)U0(x);                                                               // attributed vector: drop its index side-structure
 xG[-16]==255?mux(x):m0(xG-8);}                                                 // 255 marks foreign/mapped memory
K r1(K x){R m?inc(&x->r):++x->r,x;}                                             // r1. retain and pass through
K ka(I t){K x;                                                                  // ka. new atom of type t (t is the negative tag)
 if(acn>0)x=ac[--acn],M0+=16;                                                   // reuse a cached header when available
 else x=(K)m8(16),x->r=0,TX(K,x)=0;                                             // fresh: sole reference, zero payload
 R xt=(H)t,x;}                                                                  //
// ── typed copy ──────────────────────────────────────────────────────────────
G*dsn(V*d,V*s,I n){G*a=d,*b=s;DO(n,*a++=*b++)R a;}                              // dsn. copy n bytes, return the advanced destination (serializer building block)
#define CPW(T) {T*a=d,*b=s;DO(n,*a++=*b++)R(G*)a;}                              // CPW. copy n T-wide elements d<-s (keeps element alignment;
G*tdsn(I t,V*d,V*s,I n){I w=(I)nt(t);                                           // plain dsn would copy bytewise). tdsn. copy n elements of type t
 if(!t||t>XT)DO(n,r1(((K*)s)[i]))                                               // K-holding source: children gain an owner
 if(w==2)CPW(H)if(w==4)CPW(I)if(w==8)CPW(J)                                     // width-specialised loops
 R dsn(d,s,n);}                                                                 //
G*aak(V*a,K x){R tdsn(xt,a,xG,xn);}                                             // aak. append all of x's payload at a
// ── atom constructors ───────────────────────────────────────────────────────
K ktk(I t,K x){K r=ka(t);R TX(K,r)=x,r;}                                        // ktk. atom of t wrapping object x
K ktg(I t,I i){K x=ka(t);R TX(G,x)=(G)i,x;}                                     // ktg. byte-payload atom
K kti(I t,I i){K x=ka(t);R TX(I,x)=i,x;}                                        // kti. int-payload atom
K ktf(I t,F f){K x=ka(t);R TX(F,x)=f,x;}                                        // ktf. double-payload atom
K knano(J v){K x=ka(-KP);R TX(J,x)=v,x;}                                        // knano. timestamp atom (ns)
K kt8(I t,J v){K x=ka(-t);R TX(J,x)=v,x;}                                       // kt8. 8-byte temporal atom of t
K k_(S s){K x=ka(-KS);R TX(S,x)=s,x;}                                           // k_. symbol atom (s already interned)
K kb(I i){R ktg(-KB,i);}                                                        // kb. boolean atom
K kg(I i){R ktg(-KG,i);}                                                        // kg. byte atom
K kh(I i){K x=ka(-KH);R TX(H,x)=(H)i,x;}                                        // kh. short atom
K ki(I i){R kti(-KI,i);}                                                        // ki. int atom
K kj(J j){K x=ka(-KJ);R TX(J,x)=j,x;}                                           // kj. long atom
K ke(F e){K x=ka(-KE);R TX(E,x)=(E)e,x;}                                        // ke. real atom (f32)
K kf(F f){R ktf(-KF,f);}                                                        // kf. float atom (f64)
K ks(S s){R k_(ss(s));}                                                         // ks. symbol atom, interning the name
K kc(I i){R ktg(-KC,i);}                                                        // kc. char atom
K kd(I i){R kti(-KD,i);}                                                        // kd. date atom (days since 2000.01.01)
K kt(I i){R kti(-KT,i);}                                                        // kt. time atom (ms)
K kz(F f){R ktf(-KZ,f);}                                                        // kz. datetime atom (fractional days)
// ── vector constructors ─────────────────────────────────────────────────────
K ktn(I t,I n){K x=(K)(m1(8+n*nt(t))-4);                                        // ktn. n-vector of t; the 12B K
 if(!t)DO(n,xK[i]=0)                                                            // header overlaps the block header by 4B by design
 R x->r=0,xt=(H)t,x->u=0,xn=n,x;}                                               // mixed lists start NULL-filled
K kpn(S s,I n){K r=ktn(KC,n);R dsn(r->G,s,n),r;}                                // kpn. char vector, n bytes
K kp(S s){R kpn(s,(I)strlen(s));}                                               // kp. char vector from a C string
// ── dict / table ────────────────────────────────────────────────────────────
I qt(K x){R xt==XT||(xt==XD&&qt(xK[0])&&qt(xK[1]));}                            // qt. table or keyed table? (a keyed table is dict: table!table)
K xT(K x){U(x)P(kK(x)[0]->t!=KS,krr(ES[(r0(x),0)]))                             // xT. flip column dict
 R x=ktk(XT,x),x->u=0,x;}                                                       // to table; keys must be symbols (else free+'nyi)
K xD(K x,K y){P(!y,rxy(&x,0))R x=knk(2,x,y),xt=XD,x;}                           // xD. dict keys!values (consumes both; NULL values releases x and propagates NULL)
K TD(K x,K y){R xT(xD(x,y));}                                                   // TD. table from key list + value list
K tbl(K x){K r,y,z;I n;P(xt==XT,r1(x))                                          // tbl. flatten keyed table to simple
 y=xK[1],x=xK[0],x=TX(K,x),y=TX(K,y);                                           // unwrap key/value tables' dicts
 n=kK(x)[0]->n+kK(y)[0]->n;                                                     // total column count across both sides
 z=ktn(KS,n);aak(aak(z->G,kK(x)[0]),kK(y)[0]);                                  // merged column names
 r=ktn(0,n);aak(aak(r->G,kK(x)[1]),kK(y)[1]);                                   // merged column values
 R TD(z,r);}                                                                    //
ZK td(I n,K r){K x,y,z=kK(r)[1];I o=n>0?0:-n;                                   // td. slice dict r: first n
 if(n<0)n+=z->n;                                                                // columns (n>0) or all-but-first -n columns (n<0)
 x=ktn(KS,n),y=ktn(0,n),r=kK(r)[0];                                             //
 tdsn(x->t,x->G,((S*)r->G)+o,n);tdsn(y->t,y->G,((K*)z->G)+o,n);                 // copy name and value slices (tdsn retains the shared children)
 R TD(x,y);}                                                                    //
K ktd(K x){R xt==XT?x:qt(x)?rxy(&x,tbl(x)):krr(ES[1]);}                         // ktd. any table form to simple table; non-table is a 'type error
K knt(I n,K x){P(xt!=XT||(x=TX(K,x),kK(x)[1]->t<0),krr(ES[1]))                  // knt. key
 P(n>=kK(x)[0]->n,krr(ES[2]))                                                   // table on first n columns; n must leave
 R xD(td(n,x),td(-n,x));}                                                       // at least one value column ('length otherwise)
K knk(I n,...){K r=ktn(0,n);va_list a;va_start(a,n);                            // knk. mixed list from
 DO(n,kK(r)[i]=va_arg(a,K))R r;}                                                // n K arguments (consumes each)
// ── functional application (consuming wrappers) ─────────────────────────────
K f1(K(*f)(K),K x){U(x)R rxy(&x,f(x));}                                         // f1. r=f(x), release x, NULL-safe
K f2(K(*f)(K,K),K x,K y){if(x&&y)R rxy(&x,rxy(&y,f(x,y)));                      // f2. dyadic f;
 if(x)r0(x);if(y)r0(y);R 0;}                                                    // either arg NULL: release the other, fail
// ── list append ─────────────────────────────────────────────────────────────
K jan(K*k,V*a,I n){K x=*k,r;I b=xG[-16],c=xn+n;J w=nt(xt);                      // jan. append n
 P((UI)c>2000000000,krr(ES[15]))                                                // elements at a to *k; 2e9 = 'limit
 if(b==255||16+c*w>MZ[b])r=ktn(xt,c),aak(r->G,x),r->n=xn,*k=x=rxy(&x,r);        // outgrown (or foreign) block: reallocate and copy before appending
 R tdsn(xt,xG+xn*w,a,n),xn+=n,x;}                                               //
K ja(K*k,V*a){R jan(k,a,1);}                                                    // ja. append one raw element
K js(K*k,S s){R ja(k,&s);}                                                      // js. append an interned symbol
K jk(K*k,K y){R rxy(&y,ja(k,&y));}                                              // jk. append K object (consumes y: ja
K st(K*k,K x){R r0(*k),*k=x;}                                                   // stored+retained it, so drop our ref)
K jv(K*k,K y){R jan(k,y->G,y->n);}                                              // jv. append all of vector y
// ── byte order / lambda helpers ─────────────────────────────────────────────
S sf(K x){R x=kK(x)[3],xn?*(S*)xG:(S)"";}                                       // sf. lambda's source file name (slot 3 of the lambda structure), "" when unset
V na(I n,G*a){G j;DO(n--/2,(j=a[n-i],a[n-i]=a[i],a[i]=j))}                      // na. reverse n bytes in place (endianness swap for foreign-order frames)
K flx(K x){J n=nt(xt);if(n>1)DO(xn,na((I)n,xG+n*i))R x;}                        // flx. byte-swap every element of a foreign-endian vector
ZG*as(G*a,S s){for(;(*a++=*s++);){}R a;}                                        // as. copy NUL-terminated string, return past the NUL (symbols are sent as C strings on the wire)
iN ZS aa(S*a){S s=ss(*a);R*a+=1+(I)strlen(s),s;}                                // aa. read + intern a NUL-terminated symbol from the stream, advancing the cursor past it
ZK bng(K x,K y){R xD(r1(x),r1(y));}                                             // bng. dict from borrowed keys/values
ZK flp(K x){R xT(r1(x));}                                                       // flp. table from a borrowed column dict
// ── one-time initialisation ─────────────────────────────────────────────────
ZK*p7(I t,I n){K*p=(K*)m8((I)sizeof(K)*n);DO(n,p[i]=ktg(t,i))R p;}              // p7. singleton table: one shared atom per primitive code
V mi0(V){Z I z;if(z)R;                                                          // mi0. lazy init, idempotent
 z=1,AF=*(G*)&z,wsa(),c2(),id=t9();                                             // AF: first byte of int 1 = endianness
 DO(MN-1,MZ[i+1]+=2*MZ[i])                                                      // fold bucket sizes into powers of two
 kp1=p7(XX+1,42),kp2=p7(XX+2,34),kp3=p7(XX+3,6);                                // primitive singletons
 hh=(S*)malloc((I)sizeof(K)*2);DO(2,hh[i]=0)                                    // 2-slot intern table to start
 K0=ktn(0,0),K9=ktg(XX+1,0);}                                                   // canonical empty list + generic null
// ── error channel ───────────────────────────────────────────────────────────
V*krr(S s){es=s;R 0;}                                                           // krr. record error text, signal failure with NULL
V*orr(S s){Z C __thread b[256];                                                 // orr. krr with ": strerror(errno)" suffix
 strcpy((S)dsn(dsn(b,s,(I)strlen(s)),": ",2),sr0());R krr(b);}                  //
// ── serializer ──────────────────────────────────────────────────────────────
// Wire layout per object: type byte, then attribute byte (composite types),    //
// then payload; vectors carry a 4-byte count.  f = foreign-endianness flag.    //
J nx(I f,K x){I t=xt;J e,n;                                                     // nx. serialized byte size of x (0 = can't)
 P(!f&&(UI)(vt(t)-20)<77-20,(n=nx(f,x=ve(x)),r0(x),n))                          // enum: size inflated
 P(t<0,t==-KS?2+(I)strlen(TX(S,x)):1+nt(-t))                                    // atom: tag + payload (symbols are NUL-terminated text)
 if(t>=XT&&!q6(t)){                                                             // composite forms:
  if(t==XT)R n=nx(f,TX(K,x)),n?2+n:0;                                           // table = tag+attr + its dict
  if(t==XD)R n=nx(f,xK[1]),n?1+nx(f,xK[0])+n:0;                                 // dict = tag + keys + values
  if(t==XX)R xn==4?0:2+(I)strlen(sf(x))+nx(f,xK[xn-1]);                         // lambda = tag+attr + file name + body (4-slot lambdas are unserializable locals)
  if(t<XX+4)R 2;                                                                // primitive = tag + 1-byte code
  if(t==XX+6+6)R 0;                                                             // dynamically loaded function: cannot travel
  R 1+nx(f,TX(K,x));}                                                           // projection/composition/adverb = tag + child
 if(q6(t)){n=5+!t;DO(xn,U(e=nx(f,xK[i]))n+=e)R n;}                              // mixed list: header + sum of children (any unserializable child poisons the whole)
 P(t!=KS,6+((UI)(xt-77)<XT-77?xn*6+((J*)xG)[xn-1]*nt(xt-77):xn*nt(t)))          // vector: 6B header + data; mapped list-of-lists = offsets + flattened data
 n=6;DO(xn,n+=1+(I)strlen(((S*)xG)[i]))R n;}                                    // symbol vector: NUL-terminated
ZG*b0(I f,G*a,K x){I t=xt;                                                      // b0. serialize x at a, return the advanced a
 if((!f&&(UI)(vt(t)-20)<77-20)||(UI)(xt-77)<XT-77){                             // enum or mapped list:
  a=b0(f,a,x=(UI)(vt(t)-20)<77-20?ve(x):kv(x));R r0(x),a;}                      // inflate first
 *a++=(G)(t==XD&&x->u?127:t);                                                   // tag byte; 127 = sorted dict (keyed table)
 P(t<0,t==-KS?as(a,TX(S,x)):dsn(a,&xn,(I)nt(-t)))                               // atom payload lives at
 if(t<XD)*a++=(G)(x->u>4?4:x->u);                                               // &x->n (offset 8); vectors: attr byte
 if(t>=XT&&!q6(t)){                                                             // composite forms mirror nx:
  if(t==XT)R b0(f,a,TX(K,x));                                                   // table: its column dict
  if(t==XD)R b0(f,b0(f,a,xK[0]),xK[1]);                                         // dict: keys then values
  if(t==XX)R b0(f,a=as(a,sf(x)),xK[xn-1]);                                      // lambda: file name then body
  if(t<XX+4)R*a++=(G)(x==K9?-1:TX(G,x)),a;                                      // primitive: code (255 = null)
  R b0(f,a,TX(K,x));}                                                           // projection et al: single child
 a=dsn(a,&xn,4);                                                                // vector: 4-byte element count
 if(q6(t)){DO(xn,a=b0(f,a,xK[i]))R a;}                                          // mixed list: children in order
 P(t!=KS,dsn(a,xG,xn*(I)nt(t)))                                                 // fixed-width vector: raw payload copy
 DO(xn,a=as(a,((S*)xG)[i]))R a;}                                                // symbol vector: NUL-terminated names
// ── deserializer ────────────────────────────────────────────────────────────
ZK ur(I u,K x){U(x)R x->u=(H)u,x;}                                              // ur. re-stamp attribute after decode
ZK d0(I f,G**a){I t=*(signed char*)(*a)++,u,n;K r;S s;                          // d0. decode one
 if(t<0){P(t==-KS,k_(aa((S*)a)))                                                // object at *a; f = byte-swap needed.
  r=ka(t),dsn(&r->n,*a,n=(I)nt(-t)),*a+=n;                                      // atom: copy payload bytes
  if(f)na(n,(G*)&r->n);                                                         // foreign endianness: reverse them
  R r;}                                                                         //
 if(t<XD)u=*(*a)++;else if((u=t==127))t=XD;                                     // attr byte; tag 127 decodes as
 if(t>=XT&&!q6(t)){                                                             // a sorted dict (keyed table)
  if(t==XT)R ur(u,f1(flp,d0(f,a)));                                             // table: decode dict, flip
  if(t==XD)R r=d0(f,a),ur(u,f2(bng,r,d0(f,a)));                                 // dict: keys ! values
  if(t==XX){s=aa((S*)a),r=d0(f,a);R r?dval(s,r):0;}                             // lambda: name + body
  if(t<XX+4){u=*(*a)++;                                                         // primitive: 1-byte code selects the shared
   R u==255?r1(K9):r1((t==XX+1?kp1:t==XX+2?kp2:kp3)[u]);}                       // singleton
  R(r=d0(f,a))?ktk(t,r):0;}                                                     // projection et al: wrap the child
 if(dsn(&n,*a,4),*a+=4,f)na(4,(G*)&n);                                          // vector: 4-byte count (swapped
 r=ktn(t,n);                                                                    // for foreign frames), then n elements
 if(q6(t)){DO(n,P(!(kK(r)[i]=d0(f,a)),(r->n=i,rxy(&r,0))))R t?r:vk(r);}         // mixed: decode children; on failure trim to i so r0 frees only real ones
 if(t==KS){DO(n,((S*)r->G)[i]=aa((S*)a))}                                       // symbols: intern each name
 else if(*a+=dsn(r->G,*a,n*(I)nt(t))-r->G,f)flx(r);                             // raw copy, maybe swap
 R u?rxy(&r,uy(u,r)):r;}                                                        // reapply the transmitted attribute
// ── LZ4 block decompressor (matches the server's compressed IPC frames) ─────
ZI ulz4(V*src,I cn,V*dst,I dn){G*s=src,*se=s+cn,*d=dst,*de=d+dn;                // ulz4.
 while(s<se){I tok=*s++,ll=tok>>4,ml,off;                                       // token: hi nibble literal length
  if(ll==15){I b;do b=*s++,ll+=b;while(b==255);}                                // 15 = extended length
  P(d+ll>de||s+ll>se,-1)                                                        // bounds: corrupt frame must not overrun
  memcpy(d,s,ll);d+=ll;s+=ll;                                                   // copy literals
  if(s>=se)break;                                                               // last sequence has no match part
  off=s[0]|s[1]<<8;s+=2;                                                        // 2-byte little-endian match offset
  P(!off||d-(G*)dst<off,-1)                                                     // offset must reach into produced output
  ml=(tok&15)+4;                                                                // lo nibble match length, +4 minimum match
  if(ml==19){I b;do b=*s++,ml+=b;while(b==255);}                                // 19 = extended length
  P(d+ml>de,-1)                                                                 //
  {G*ref=d-off;DO(ml,d[i]=ref[i])d+=ml;}}                                       // byte-wise: overlap is legal
 R(I)(d-(G*)dst);}                                                              // decompressed size
// ── framing ─────────────────────────────────────────────────────────────────
// Frame: byte 0 = sender endianness, 1 = message type (0 async, 1 sync,        //
// 2 response), 2 = compression flag, 3 = 0, bytes 4-7 = total length.          //
K d9(K x){G*a;K ipc,r;                                                          // d9. decode a whole received frame x
 if(xG[2]==1){I un=((I*)(xG+8))[0];                                             // compressed: first payload int is the
  ipc=ktn(KG,8+un);dsn(ipc->G,xG,8);ipc->G[2]=0;                                // uncompressed size; keep
  ulz4(xG+12,xn-12,ipc->G+8,un);((I*)ipc->G)[1]=8+un;}                          // header, clear flag
 else r1(x),ipc=x;                                                              // raw frame: decode in place
 a=ipc->G+8;                                                                    //
 r=*a==128?krr(ss((S)(a+1))):d0(AF!=*ipc->G,&a);                                // tag 128 = error reply; else decode, swapping if the sender's endianness differs from ours
 R r0(ipc),r;}                                                                  //
ZK b7(I n){K r=ktn(KG,8+n);                                                     // b7. blank frame: n payload bytes + 8B header
 R((I*)r->G)[0]=0,*r->G=(G)AF,((I*)r->G)[1]=r->n,r;}                            // stamp endianness+len
K b9(I f,K x){K r;J n=nx(f,x);                                                  // b9. serialize x into a framed byte vector
 P(!n,krr(ES[1]))P(n>2000000000,krr(ES[15]))                                    // unserializable / too big
 r=b7((I)n),b0(f,r->G+8,x);                                                     //
 R((I*)r->G)[1]=r->n,r;}                                                        // (re)stamp total length after the payload write
K b6(I f,K x){                                                                  // b6. serialize-or-error frame (server-side response path;
 if(!x||!(x=rxy(&x,b9(f,x))))x=b7(2+(I)strlen(es));                             // kept for ABI parity —
 x->G[8]=(G)-128,as(x->G+9,es),clr();                                           // NOTE historical: stamps the -128
 R x->G[1]=2,x;}                                                                // error tag unconditionally, exactly as always shipped
// ── hostname helpers ────────────────────────────────────────────────────────
S lwc(S s,I n){DO(n,s[i]+=32*(26u>(UI)(s[i]-'A')))R s;}                         // lwc. ASCII lower-case n bytes in place (branchless: +32 only for 'A'..'Z')
S lws(S s){I n=(I)strlen(s);S p=(S)m1(n+1);                                     // lws. interned lower-case copy
 R s=ss(lwc(strcpy(p,s),n)),m0(p),s;}                                           // (scratch buffer freed immediately)
Z struct hostent*h;Z struct sockaddr_in sa={AF_INET};                           // shared lookup state
typedef struct sockaddr*Sa;                                                     // Sa. abbreviates the sockaddr cast
S oip(I a){struct in_addr x;x.s_addr=a;R inet_ntoa(x);}                         // oip. IP as text
S host(I a){mi0(),a=htonl(a);                                                   // host. reverse-DNS an IPv4 address to an
 h=gethostbyaddr((S)&a,4,AF_INET);R h?lws(h->h_name):ss("");}                   // interned lower-case name ("" when unresolvable)
I hl(I a,S s){S*t;a=htonl(a);                                                   // hl. does host a match ACL pattern s?
 U(h=gethostbyaddr((S)&a,4,AF_INET))                                            //
 P(lk(lws(h->h_name),s),1)                                                      // canonical name, then every DNS alias
 for(t=(S*)h->h_aliases;*t;++t)P(lk(lws(*t),s),1)                               //
 R 0;}                                                                          //
// ── sockets ─────────────────────────────────────────────────────────────────
I pd(I d){socklen_t n=16;R getsockname(d,(Sa)&sa,&n),ntohs(sa.sin_port);}       // pd. local port of a bound socket
ZI sopt(I d,I o,I i){R setsockopt(d,o?SOL_SOCKET:IPPROTO_TCP,                   // sopt. set
 o?o:TCP_NODELAY,(S)&i,4);}                                                     // option o to i (o=0 means TCP_NODELAY)
I sock(V){I d=(I)socket(AF_INET,SOCK_STREAM,0);P(-1==d,d)                       // sock. TCP socket
 R sopt(d,0,1),sopt(d,SO_KEEPALIVE,1),sopt(d,SO_REUSEADDR,1),d;}                // no-delay (queries are small+latency-bound), keepalive, fast rebind
I cb(I f,I d,I a,I p){struct sockaddr_in x={AF_INET};                           // cb. connect (f=1)
 x.sin_port=htons((H)p),x.sin_addr.s_addr=htonl(a);                             // or bind (f=0) d to
 R(f?connect:bind)(d,(Sa)&x,16)&&!qip()?(cls(d),-1):exe(d);}                    // a:p; EINPROGRESS is fine (non-blocking connect completes later)
I conn(I a,I p){R cb(1,sock(),a,p);}                                            // conn. open a TCP connection to a:p
I lstn(I a,I p){I d=cb(0,sock(),a,p);                                           // lstn. bound listening socket on a:p
 R -1==d?d:listen(d,1000)?(cls(d),-1):d;}                                       //
I accp(I d,I*a){socklen_t n=16;d=(I)accept(d,(Sa)&sa,&n);                       // accp. accept a
 R*a=ntohl(sa.sin_addr.s_addr),d;}                                              // peer, reporting its IPv4 address in *a
I addr(S s){I a;mi0();                                                          // addr. resolve s to a host-order IPv4 address
 P(!*s,0x7F000001)                                                              // "" means localhost
 P(-1!=(a=(I)inet_addr(s)),(I)ntohl(a))                                         // dotted-quad literal
 h=gethostbyname(s);R h?(I)ntohl(*(I*)h->h_addr_list[0]):-1;}                   // else DNS
// ── connection handshake ────────────────────────────────────────────────────
I khpu(S s,I p,S u){I a=addr(s),d;                                              // khpu. connect + authenticate: send the
 P(-1==a,a)P(-1==(d=conn(a,p)),d)                                               // NUL-terminated "user:pass", server ACKs
 m=1;snd(d,u,1+(I)strlen(u));                                                   // with 1 byte. m=1: refcounts go atomic now.
 R 1==(a=rcv(d,&p,1))?d:(cls(d),a);}                                            // no ACK = auth refused: close, 0/-1
I khp(S s,I p){R khpu(s,p,"");}                                                 // khp. connect with empty credentials
I rcv(I d,V*b,I n){R(I)recv(d,b,n,0);}                                          // rcv. plain recv wrapper
I snd(I d,V*b,I n){R(I)send(d,b,n,0);}                                          // snd. plain send wrapper
// ── frame transport ─────────────────────────────────────────────────────────
I sfd(I f,I d,K x){I j,n;                                                       // sfd. pump frame x on d: f=1 read into x, f=0
 for(;n=((I*)xG)[1]-xn,j=f?rcv(d,xG+xn,n):snd(d,xG+xn,n),j>0;)                  // write from
  P((xn+=j,j==n),1)                                                             // x; x->n tracks progress toward the length in bytes
 R qbl()-1;}                                                                    // 4-7. 0 = would-block (retry later), -1 = hard socket error
K x8(S b){K r;S p=b+4;                                                          // x8. turn an 8-byte frame header into the frame
 P(b[1]>2||b[3],krr(ES[7]))                                                     // buffer; bad type/pad byte = 'parse
 if(AF!=*b)na(4,(G*)p);                                                         // foreign endianness: swap the length field
 R r=ktn(KG,*(I*)p),dsn(r->G,b,r->n=8),r;}                                      // n=8: payload appended by sfd
K rd(I d){K r;C b[8];I i=0,j;                                                   // rd. blocking-read one whole frame from d
 for(;i<8;i+=j)P(1>(j=rcv(d,b+i,8-i)),j?orr("rcv"):krr("close"))                // header first: 0 bytes = orderly close, <0 = socket error
 U(r=x8(b))                                                                     //
 P(-1==sfd(1,d,r),orr((r0(r),"rcv")))                                           // then the payload
 R r;}                                                                          //
K wd(I d,K r){r->n=0;P(-1==sfd(0,d,r),orr("snd"))R r;}                          // wd. write frame r (n rewound to 0: sfd counts bytes already sent)
K ww(I d,K r){I f=d>0;U(r=b9(0,r))                                              // ww. serialize + send r on |d|; d<0 =
 R r->G[1]=(G)f,rxy(&r,wd(f?d:-d,r));}                                          // async message type 0, else sync 1
// ── query execution ─────────────────────────────────────────────────────────
ZK ee(K x){R x?x:(x=k_(es),clr(),xt=-128,x);}                                   // ee. NULL result -> type
ZK rr(I d){K r=rd(d);U(r)R ee(f1(d9,r));}                                       // -128 error object carrying es.
ZK go(I i,K r){R rxy(&r,!i?ee(val(r)):!ww(i,r)?0:i>0?rr(i):r);}                 // go. ship query list r on handle i: i>0 sync (returns the
// reply), i<0 async (returns the sent frame), i=0 local (nyi here).            //
ZK kva(I i,S s,va_list a){K r,x;                                                // kva. shared variadic body of k()/l_execute:
 for(r=kp(s);(x=va_arg(a,K));jk(&r,x))if(r->t)r=knk(1,r);                       // first arg turns the query text into (text;arg;...) generic list
 R go(i,r);}                                                                    // ((K)0 terminates the K args)
K k(I i,S s,...){va_list a;P(!s,rr(i))                                          // k. execute s on handle i (see go);
 va_start(a,s);R kva(i,s,a);}                                                   // NULL s just reads the next incoming message (callback/async receipt)
// ── calendar arithmetic ─────────────────────────────────────────────────────
ZI em[]={0,31,61,92,122,153,184,214,245,275,306,337};                           // em. cumulative days
// before each month of the shifted (March-first) year: makes leap day last     //
ZI ey(I y){R y/400-y/100+(y>>2)+365*y-730425;}                                  // ey. days from 2000.01.01 to
I de(I y,I m){I b=m<2;R ey(y-b)+em[b?m+10:m-2];}                                // year y; de. to y-m (m is
ZI ab(F c,I*d){I r=(I)((.75+*d)/c);R*d-=(I)(r*c),r;}                            // 1-based-1). ab. split
I ed(I d){I c,y,m;                                                              // *d into r whole periods of length c plus remainder.
 R d+=730425,c=ab(36524.25,&d),y=ab(365.25,&d),                                 // ed. day count back to
  m=(2+5*d)/153,d-em[m]+32*(m+2+12*(100*c+y-2000));}                            // packed y/m/d fields
I ymd(I y,I m,I d){I e;                                                         // ymd. y/m/d to days since 2000.01.01, validating
 R y>(I)0x80000000&&m>0&&m<13&&(e=de(y,m-1),d&&--d<de(y+m/12,m%12)-e)           // that
  ?e+d:(I)0x80000000;}                                                          // d fits the month; 0x80000000 = int null on failure
I dj(I d){I m=((d=ed(d))>>5)+24000;                                             // dj. day count to decimal yyyymmdd
 R 10000*(m/12)+100*(1+m%12)+1+(d&31);}                                         //
// ═══════════════════════════════════════════════════════════════════════════  //
// l_* public API — fully-named FFI-friendly wrappers (see l_interface.h).      //
// Bun's bun:ffi cannot call C variadics, so fixed-arity l_execute1/2/3 and     //
// the pointer-array l_execute_args cover every arity of k().                   //
// ═══════════════════════════════════════════════════════════════════════════  //
typedef K l_object;typedef int l_type;typedef int l_handle;                     // public aliases
#define l_null (l_object)0                                                      // the NULL object / vararg terminator
V l_close_connection(l_handle c){close(c);}                                     // drop a connection handle
V l_raise_error(S s){}                                                          // raise in embedded L — inert: this build never
V l_raise_syserror(S s){}                                                       // embeds, errors flow back over IPC instead
S l_intern(S s){R ss(s);}                                                       // intern a NUL-terminated symbol name
S l_intern_n(S s,I n){R sn(s,n);}                                               // intern the first n characters
V l_release(l_object x){r0(x);}                                                 // give up one reference
V l_retain(l_object x){r1(x);}                                                  // take one more reference
// ── constructors ────────────────────────────────────────────────────────────
#define NEWA(N,VT,F0) l_object l_new_##N(VT v){R F0(v);}                        // NEWA. one-value constructor l_new_N as a wrapper over core F0
l_object l_new_atom(l_type t){R ka(t);}                                         // uninitialised atom of type t
NEWA(bool,I,kb)NEWA(byte,I,kg)NEWA(short,H,kh)NEWA(int,I,ki)                    //
NEWA(long,J,kj)NEWA(real,E,ke)NEWA(float,F,kf)NEWA(char,C,kc)                   //
NEWA(symbol,S,ks)NEWA(string,S,kp)                                              // symbol interns v; string copies it into a char vector
NEWA(date,I,kd)NEWA(time,I,kt)NEWA(datetime,F,kz)NEWA(timestamp,J,knano)        // days since 2000.01.01 / ms / fractional days / ns since 2000
l_object l_new_timespan(J v){R kt8(16,v);}                                      // ns duration (type 16)
l_object l_new_atom_bits(l_type t,J b){K x=ka(t);R TX(J,x)=b,x;}                // atom of t with a BIT-EXACT payload: callers whose FFI runtime mangles
// floating-point arguments (Bun lowers NaN and -0.0 f64 args to +0.0)          //
// pass the raw IEEE bits through this integer path instead                     //
V l_set_bits_at(l_object o,I i,J b){K x=o;                                      // bit-exact element store,
 if(8==nt((UI)xt))kJ(x)[i]=b;else kI(x)[i]=(I)b;}                               // sized by the list's element width (f64/f32 twin of the setters above)
l_object l_new_list(l_type t,I n){R ktn(t,n);}                                  // typed n-vector
l_object l_new_string_n(S v,I n){R kpn(v,n);}                                   // char vector, first n bytes
l_object l_new_mixed_list(I n,...){K r=ktn(0,n);va_list a;va_start(a,n);        // n
 DO(n,kK(r)[i]=va_arg(a,K))R r;}                                                // K varargs, each consumed into the list
l_object l_new_dict(l_object k,l_object v){R xD(k,v);}                          // keys!values
l_object l_table_from_dict(l_object d){R xT(d);}                                // flip column dict
l_object l_keyed_from_simple(l_object x){R ktd(x);}                             // keyed -> simple table
// ── dict / list access ──────────────────────────────────────────────────────
l_object l_get_keys(l_object d){K x=d;P(XD!=xt,krr("notdict"))R xK[0];}         // borrowed reference to the key side of a dict
l_object l_get_values(l_object d){K x=d;P(XD!=xt,krr("notdict"))R xK[1];}       // borrowed reference to the value side of a dict
l_object l_append_atom(l_object*l,V*a){R ja((K*)l,a);}                          // append raw scalar
l_object l_append_string(l_object*l,G*s){R js((K*)l,(S)s);}                     // append symbol
l_object l_append_object(l_object*l,l_object o){R jk((K*)l,o);}                 // append K (consumed); *l may relocate on growth
// ── connections and queries ─────────────────────────────────────────────────
l_handle l_secure_connect(const char*s,I p,S u){R khpu((S)s,p,u);}              // open + authenticate with "user:pass" credentials u
l_handle l_connect(const char*s,I p){R l_secure_connect(s,p,"");}               //
l_object l_execute(l_handle i,const char*s,...){va_list a;                      // variadic
 P(!s,rr(i))va_start(a,s);R kva(i,(S)s,a);}                                     // twin of k() for FFI systems that can build va_lists
bool l_health_check(l_handle c){K x=l_execute(c,"1+1",l_null);                  // liveness:
 R x&&xt==-KI&&xi==2;}                                                          // a healthy server answers 1+1 with the int atom 2
I l_encode_date(I y,I mo,I d){R ymd(y,mo,d);}                                   // yyyy,mm,dd -> date value
l_object l_add_callback(I d,l_object(*f)(I)){R krr("notembedded");}             // main-
V l_remove_callback(I d){}                                                      // loop socket callbacks exist only embedded
l_object l_load(V*f,I i){R krr("notembedded");}                                 // dynamic-load: embedded only
l_object l_dot(l_object x,l_object y){R krr("notembedded");}                    // local .[x;y] apply needs the interpreter: use l_execute over IPC instead
// ── predicates ──────────────────────────────────────────────────────────────
bool l_is_error(l_object o){R -128==o->t;}                                      //
bool l_is_scalar(l_object o){R o->t<0;}                                         // negative type tag = atom
bool l_is_mixed_list(l_object o){R o->t==0;}                                    //
bool l_is_list(l_object o){R o->t>0;}                                           // any positive tag is a vector
bool l_is_dict(l_object o){R XD==o->t;}                                         //
bool l_is_table(l_object o){R XT==o->t;}                                        //
bool l_is_keyed_table(l_object o){K x=o;P(XD!=xt,false)                         // keyed table =
 R XT==xK[0]->t&&XT==xK[1]->t;}                                                 // dict mapping a table to a table
// ── datetime conversion ─────────────────────────────────────────────────────
F l_datetime_of_unix(I u){R u/8.64e4-10957;}                                    // unix seconds -> fractional
I l_unix_of_datetime(F v){R(I)(86400*(v+10957));}                               // days since 2000.01.01,
// and back (10957 = days between the 1970 and 2000 epochs)                     //
// ── non-variadic query execution ────────────────────────────────────────────
l_object l_k(l_handle h,const char*s){R s?k(h,(S)s,(K)0):rr(h);}                // 0 args; NULL s reads the next incoming message instead
l_object l_execute1(l_handle h,const char*s,l_object a){                        // 1 arg (consumed,
 R s?k(h,(S)s,a,(K)0):rr(h);}                                                   // as are all args below — retain to keep)
l_object l_execute2(l_handle h,const char*s,l_object a,l_object b){             // 2 args
 R s?k(h,(S)s,a,b,(K)0):rr(h);}                                                 //
l_object l_execute3(l_handle h,const char*s,l_object a,l_object b,              // 3 args
 l_object c){R s?k(h,(S)s,a,b,c,(K)0):rr(h);}                                   //
l_object l_execute_args(l_handle h,const char*s,l_object*g,I n){K r;            // n
 P(!s,rr(h))                                                                    // args from a pointer array (FFI-friendly for 4+ arguments;
 r=kp((S)s);DO(n,if(g[i]){jk(&r,g[i]);if(r->t)r=knk(1,r);})                     // NULL slots
 R go(h,r);}                                                                    // are skipped)
l_object l_apply(l_handle h,const char*fn,l_object args){K a=args,r;            // call
 P(!fn||!a,krr("null"))                                                         // function fn with a pre-built mixed list of args
 P(a->t!=0,krr("args must be mixed list"))                                      //
 P(a->n==1,k(h,(S)fn,kK(a)[0],(K)0))                                            // small arities go straight to k()
 P(a->n==2,k(h,(S)fn,kK(a)[0],kK(a)[1],(K)0))                                   //
 P(a->n==3,k(h,(S)fn,kK(a)[0],kK(a)[1],kK(a)[2],(K)0))                          //
 r=kp((S)fn);DO(a->n,jk(&r,kK(a)[i]);if(r->t)r=knk(1,r))                        // 4+: build the
 R go(h,r);}                                                                    // generic list by hand
// ── introspection ───────────────────────────────────────────────────────────
H l_get_type(l_object o){R o->t;}                                               // type tag (see the l_type enum)
I l_get_length(l_object o){R o->n;}                                             // element count of a vector
G*l_get_data(l_object o){K x=o;R xt<0?(G*)&xn:xG;}                              // raw payload pointer (atom: the 8B at &n; vector: element data) — lets a
// caller read n*width bytes directly, e.g. a char vector of ANY length         //
// (l_get_string_value copies through a fixed 64KB buffer and truncates)        //
// ── atom value getters (TX reads the payload at byte offset 8) ──────────────
#define GETV(N,T,RT) RT l_get_##N##_value(l_object o){R(RT)TX(T,o);}            // GETV. atom getter l_get_N_value: payload T returned as RT
GETV(bool,G,I)GETV(byte,G,I)GETV(short,H,H)GETV(int,I,I)GETV(long,J,J)          //
GETV(real,E,E)GETV(float,F,F)GETV(char,G,C)GETV(symbol,S,S)                     // symbol is interned: do not free
GETV(real_as_double,E,F)                                                        // f32 widened to f64: sidesteps FFI runtimes with broken f32 return ABIs
Z C __thread sb[65536];                                                         // sb. reused NUL-termination buffer for strings
S l_get_string_value(l_object o){K x=o;I n;                                     // char vector/atom as a C
 P(xt!=KC&&xt!=-KC,0)                                                           // string; NULL for any other type. The buffer is
 n=xt==KC?xn:1;if(n>(I)sizeof(sb)-1)n=(I)sizeof(sb)-1;                          // reused per call —
 R memcpy(sb,kC(x),n),sb[n]=0,sb;}                                              // copy out if you need to keep it
// ── vector element getters (no bounds checks: caller stays in range) ────────
#define GETA(N,A,RT) RT l_get_##N##_at(l_object o,I i){R(RT)A(o)[i];}           // GETA. element getter l_get_N_at: A-typed payload returned as RT
GETA(int,kI,I)GETA(long,kJ,J)GETA(float,kF,F)GETA(byte,kG,G)                    //
GETA(short,kH,H)GETA(real,kE,E)GETA(real_as_double,kE,F)GETA(symbol,kS,S)       //
GETA(object,kK,l_object)                                                        // borrowed child from a mixed list, dict, or table
// ── vector element setters ──────────────────────────────────────────────────
#define SETA(N,A,VT) V l_set_##N##_at(l_object o,I i,VT v){A(o)[i]=v;}          // SETA. element setter l_set_N_at storing a VT into the A-typed payload
SETA(int,kI,I)SETA(long,kJ,J)SETA(float,kF,F)SETA(byte,kG,G)                    //
SETA(short,kH,H)SETA(real,kE,E)                                                 //
V l_set_symbol_at(l_object o,I i,S v){kS(o)[i]=ss(v);}                          // interns the name
V l_set_boolean_at(l_object o,I i,I v){kG(o)[i]=(G)(v!=0);}                     //
V l_set_object_at(l_object o,I i,l_object v){if(o->t==0)kK(o)[i]=v;}            // mixed lists only: typed vectors hold scalars, not K pointers
// ── smart append ────────────────────────────────────────────────────────────
l_object l_list_append_object(l_object list,l_object obj){K l=list,o=obj;       //
 if(l->t>0&&o->t<0&&-o->t==l->t)                                                // atom type matches the list: unbox the
  SW(l->t){CS(KS,js(&l,TX(S,o)))                                                // scalar so the vector stays flat
   case KI:case KD:case KT:ja(&l,&TX(I,o));break;                               // 4-byte int family
   CS(KJ,ja(&l,&TX(J,o)))                                                       //
   case KF:case KZ:ja(&l,&TX(F,o));break;                                       // 8-byte float family
   CS(KE,ja(&l,&TX(E,o)))CS(KH,ja(&l,&TX(H,o)))                                 //
   case KG:case KB:case KC:ja(&l,&TX(G,o));break;                               // byte family
   CD:jk(&l,o);}                                                                // unexpected tag: fall back to boxed append
 else jk(&l,o);                                                                 // mixed list or type mismatch: append the K object itself
 R l;}                                                                          // note: l may have been relocated by growth
// ── table helpers ───────────────────────────────────────────────────────────
l_object l_table_to_dict(l_object o){K x=o;                                     // the column dict inside a
 R xt==XT?TX(K,x):(K)krr("not a table");}                                       // table (borrowed reference)
l_object l_call_insert(l_handle h,l_object sym,l_object row){K s=sym,r=row;     //
 P(!s||!r,krr("null"))                                                          // insert[sym;row] over IPC. k() consumes its args,
 P(s->t!=-KS,krr("sym expected"))                                               // but the caller may still hold these —
 P(r->t!=0,krr("list expected"))                                                // retain both so their references survive
 R r1(s),r1(r),k(h,"insert",s,r,(K)0);}                                         //
l_object l_real_list_to_float_list(l_object o){K x=o,r;                         // widen an f32 (KE)
 P(xt!=KE,krr("not real vec"))                                                  // vector to f64 (KF) — JS numbers are f64
 r=ktn(KF,xn);DO(xn,kF(r)[i]=(F)kE(x)[i])R r;}                                  //
V l_debug_print(l_object o){K x=o;                                              // dump header + small-atom payload to
 printf("K{t=%d u=%d n=%d",xt,x->u,xn);                                         // stdout during development
 if(xt==-KI)printf(" v=%d",TX(I,x));                                            //
 else if(xt==-KF)printf(" v=%g",TX(F,x));                                       //
 else if(xt==-KS)printf(" v=%s",TX(S,x));                                       //
 printf("}\n");}                                                                //
#ifdef __cplusplus                                                              //
}                                                                               //
#endif                                                                          //
