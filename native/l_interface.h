// l_interface.h — public C API of liblconn, the L database connector.          //
// This header declares exactly the surface the Bun client dlopens              //
// (src/ffi.ts): connect/execute, reference counting, introspection,            //
// constructors, and element accessors.  Objects are opaque handles;            //
// read and write them only through the functions below.                        //
//                                                                              //
// REFERENCE COUNTING.  An object you create must eventually meet               //
// exactly one of: l_release(o); storage inside another l_object                //
// (which then owns it); or an l_execute* call, which consumes its              //
// object arguments.  A borrowed reference — for example a child                //
// obtained with l_get_object_at — must first be l_retain'ed (turning           //
// it into an owned one) before any of the above may be applied.                //
//                                                                              //
// C TYPE PER L TYPE.  boolean/byte/char = char, short = int16_t,               //
// int/month/minute/second = int32_t, long = int64_t, real = float,             //
// float = double, symbol = char* (interned), date = int32_t days from          //
// 2000.01.01, datetime = double days from 2000.01.01, timestamp and            //
// timespan = int64_t nanoseconds, time = int32_t milliseconds.                 //
#ifdef __cplusplus                                                              //
extern "C" {                                                                    //
#endif                                                                          //
#ifndef _L_INTERFACE                                                            //
#define _L_INTERFACE                                                            //
#include <stdbool.h>                                                            // bool: l_is_error
#include <stdint.h>                                                             // exact-width value types
// Type tags carried by l_objects.  A positive value tags a vector of           //
// that type; by convention the negated value tags a single atom of it          //
// (so -l_float is a float atom).  Read a tag with l_get_type.                  //
typedef enum {                                                                  //
 l_error=-128,                                                                  // an error object; the message is its symbol payload
 l_mixed_list=0,                                                                // list holding l_objects of differing types
 l_boolean=1,                                                                   // 1 byte, C char
 l_byte=4,                                                                      // 1 byte, C char
 l_short=5,                                                                     // 2 bytes, C int16_t
 l_int=6,                                                                       // 4 bytes, C int32_t
 l_long=7,                                                                      // 8 bytes, C int64_t
 l_real=8,                                                                      // 4 bytes, C float
 l_float=9,                                                                     // 8 bytes, C double
 l_char=10,                                                                     // 1 byte, C char
 l_symbol=11,                                                                   // pointer-sized, C char* (interned)
 l_timestamp=12,                                                                // 8 bytes, int64_t: ns since 2000.01.01
 l_month=13,                                                                    // 4 bytes, C int32_t
 l_date=14,                                                                     // 4 bytes, int32_t: days since 2000.01.01
 l_datetime=15,                                                                 // 8 bytes, double: days since 2000.01.01
 l_timespan=16,                                                                 // 8 bytes, int64_t: nanosecond duration
 l_minute=17,                                                                   // 4 bytes, C int32_t
 l_second=18,                                                                   // 4 bytes, C int32_t
 l_time=19,                                                                     // 4 bytes, int32_t: milliseconds
 l_table=98,                                                                    // simple table: rows of named columns
 l_dict=99,                                                                     // key list ! value list
 l_lambda=100                                                                   // L function
} l_type;                                                                       //
typedef struct l_object_ *l_object;                                             // opaque value handle: every L value, simple or complex
typedef int l_handle;                                                           // open connection; negative = error during connect,
// zero = access was denied                                                     //
// ── initialisation ──────────────────────────────────────────────────────────
void mi0(void);                                                                 // one-time library init; call once before anything else
// ── connections ─────────────────────────────────────────────────────────────
l_handle l_connect(const char *host, int port);                                 // connect to an unsecured
// L instance listening on host:port; returns the connection handle            //
l_handle l_secure_connect(const char *host, int port, char *credentials);       // connect with "username:password" credentials (sent in cleartext)
void l_close_connection(l_handle connection);                                   // close an open connection
// ── query execution ─────────────────────────────────────────────────────────
// Every trailing l_object argument is consumed by the call (l_retain           //
// first to keep it).  The returned result is owned by the caller and           //
// must be l_release'd; a NULL query reads the next incoming message.           //
l_object l_k(l_handle connection, const char *query);                           // no arguments
l_object l_execute1(l_handle connection, const char *query, l_object a);        // 1 argument
l_object l_execute2(l_handle connection, const char *query, l_object a,         // 2 arguments
 l_object b);                                                                   //
l_object l_execute3(l_handle connection, const char *query, l_object a,         // 3 arguments
 l_object b, l_object c);                                                       //
l_object l_execute_args(l_handle connection, const char *query,                 // n arguments
 l_object *args, int32_t n);                                                    // from a pointer array (NULL slots are skipped)
// ── reference counting ──────────────────────────────────────────────────────
void l_retain(l_object value);                                                  // we are keeping a reference to this value
void l_release(l_object value);                                                 // we no longer need it; the value may be
// deallocated once no other retained references remain                         //
// ── introspection ───────────────────────────────────────────────────────────
bool l_is_error(l_object);                                                      // is this an error object (type -128)?
int16_t l_get_type(l_object);                                                   // type tag (see l_type; negative = atom)
int32_t l_get_length(l_object);                                                 // element count of a vector
unsigned char *l_get_data(l_object);                                            // raw payload pointer (borrowed): length*width bytes of vector
// data, or the atom payload; unlike l_get_string_value it never truncates      //
// ── atom value getters ──────────────────────────────────────────────────────
int32_t l_get_bool_value(l_object);                                             //
int32_t l_get_byte_value(l_object);                                             //
int16_t l_get_short_value(l_object);                                            //
int32_t l_get_int_value(l_object);                                              // also month/date/minute/second/time
int64_t l_get_long_value(l_object);                                             // also timestamp/timespan
float l_get_real_value(l_object);                                               //
double l_get_real_as_double_value(l_object);                                    // real widened to double (for FFI runtimes with broken f32 return ABIs)
double l_get_float_value(l_object);                                             // also datetime
char l_get_char_value(l_object);                                                //
char *l_get_symbol_value(l_object);                                             // interned: do not free
char *l_get_string_value(l_object);                                             // char vector/atom as a C string; the buffer is reused per call — copy to keep
// ── vector element getters (no bounds checks: caller stays in range) ────────
int32_t l_get_int_at(l_object, int32_t i);                                      //
int64_t l_get_long_at(l_object, int32_t i);                                     //
double l_get_float_at(l_object, int32_t i);                                     //
unsigned char l_get_byte_at(l_object, int32_t i);                               //
int16_t l_get_short_at(l_object, int32_t i);                                    //
double l_get_real_as_double_at(l_object, int32_t i);                            //
char *l_get_symbol_at(l_object, int32_t i);                                     //
l_object l_get_object_at(l_object, int32_t i);                                  // borrowed child from a mixed list, dict, or table
// ── vector element setters ──────────────────────────────────────────────────
void l_set_int_at(l_object, int32_t i, int32_t v);                              //
void l_set_long_at(l_object, int32_t i, int64_t v);                             //
void l_set_float_at(l_object, int32_t i, double v);                             //
void l_set_byte_at(l_object, int32_t i, unsigned char v);                       //
void l_set_short_at(l_object, int32_t i, int16_t v);                            //
void l_set_real_at(l_object, int32_t i, float v);                               //
void l_set_bits_at(l_object, int32_t i, int64_t bits);                          // store exact payload bits, sized by the list's element width
void l_set_symbol_at(l_object, int32_t i, char *v);                             // interns the name
// ── atom constructors ───────────────────────────────────────────────────────
l_object l_new_bool(int val);                                                   // boolean atom
l_object l_new_byte(int val);                                                   // byte atom
l_object l_new_short(int16_t val);                                              // short atom
l_object l_new_int(int32_t val);                                                // int atom
l_object l_new_long(int64_t val);                                               // long atom
l_object l_new_real(float val);                                                 // real atom
l_object l_new_float(double val);                                               // float atom
l_object l_new_char(char val);                                                  // char atom
l_object l_new_symbol(char *val);                                               // symbol atom (interns val)
l_object l_new_string(char *val);                                               // char vector from a C string
l_object l_new_string_n(char *val, int32_t n);                                  // char vector from the first n bytes (interior NULs preserved)
l_object l_new_date(int32_t val);                                               // date atom (days since 2000.01.01)
l_object l_new_time(int32_t val);                                               // time atom (milliseconds)
l_object l_new_datetime(double val);                                            // datetime atom (days, fractional)
l_object l_new_timestamp(int64_t val);                                          // timestamp atom (ns since 2000)
l_object l_new_timespan(int64_t val);                                           // timespan atom (ns duration)
l_object l_new_atom_bits(l_type t, int64_t bits);                               // atom of t carrying these exact payload bits: the integer route
// for FFI runtimes that mangle floating-point arguments (e.g. NaN, -0.0)       //
// ── collections ─────────────────────────────────────────────────────────────
l_object l_new_list(l_type type, int32_t length);                               // vector of type and length
l_object l_new_dict(l_object keys, l_object values);                            // dict keys!values (consumes both)
l_object l_list_append_object(l_object list, l_object obj);                     // append obj (consumed;
// an atom matching the list type is unboxed); returns the list, which          //
// may have been relocated to a larger allocation                               //
l_object l_table_to_dict(l_object table);                                       // the column dict inside a table (borrowed)
#endif                                                                          // _L_INTERFACE
#ifdef __cplusplus                                                              //
}                                                                               //
#endif                                                                          //
