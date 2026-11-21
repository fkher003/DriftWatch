import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import {
  scenario,
  targetSchema,
  type Target,
  type Scenario,
} from "@driftwatch/contracts";

type Resolve = (host: string) => Promise<{ address: string }[]>;
export interface ApprovedTarget {
  url: URL;
  address?: string;
}
export async function approveTarget(
  input: Target,
  origin: string,
  fault: Scenario = "HEALTHY",
  login = false,
  resolve: Resolve = (host) => lookup(host, { all: true, verbatim: true }),
): Promise<ApprovedTarget> {
  const target = targetSchema.parse(input);
  if (target.kind === "sandbox") {
    const base = new URL(origin);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.href !== base.origin + "/"
    )
      throw Error("Invalid sandbox origin");
    const route = login ? "login" : target.flow;
    return {
      url: new URL("/sandbox/v1/" + route + "/" + scenario.parse(fault), base),
    };
  }
  const url = new URL(target.url);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [{ address: host }] : await resolve(host);
  if (
    !ips.length ||
    ips.some(({ address }) => {
      const ip = ipaddr.process(address);
      return (
        ip.range() !== "unicast" ||
        ip.toString() === "168.63.129.16" ||
        (ip.kind() === "ipv6" && (ip.toByteArray()[0]! & 0xe0) !== 0x20)
      );
    })
  )
    throw Error("Public unicast addresses required");
  return { url, address: ips[0]!.address };
}
