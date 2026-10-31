import {scalaTls} from '../scala-support';

/** The Scala support: the shared TLS helper the HTTP steps import as `counters.Tls`. */
export const supportModulesScala: Record<string, string> = {...scalaTls('counters')};
