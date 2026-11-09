import { describe, expect, it } from "vitest";
import { readTemplate, resource } from "./cfn.ts";

// The DNS stack the owner applies once, in us-east-1, before anything
// deploys (#4, #15).
const template = readTemplate("infra/dns.cfn.yml");

describe("the DNS stack", () => {
  it("holds the hosted zone for grantlink.uk, kept if the stack goes", () => {
    const zone = resource(template, "HostedZone");
    expect(zone.Type).toBe("AWS::Route53::HostedZone");
    expect(zone.Properties.Name).toEqual({ Ref: "DomainName" });
    expect(zone.DeletionPolicy).toBe("Retain");
    expect(zone.UpdateReplacePolicy).toBe("Retain");
    expect(template.Parameters?.DomainName?.Default).toBe("grantlink.uk");
  });

  it("holds a certificate for the domain, validated by DNS in the zone", () => {
    const certificate = resource(template, "Certificate");
    expect(certificate.Type).toBe("AWS::CertificateManager::Certificate");
    expect(certificate.Properties).toMatchObject({
      DomainName: { Ref: "DomainName" },
      ValidationMethod: "DNS",
      DomainValidationOptions: [
        {
          DomainName: { Ref: "DomainName" },
          HostedZoneId: { Ref: "HostedZone" },
        },
      ],
    });
  });

  it("outputs the nameservers, the zone's id and the certificate's ARN", () => {
    expect(template.Outputs?.NameServers?.Value).toEqual({
      "Fn::Join": [", ", { "Fn::GetAtt": ["HostedZone", "NameServers"] }],
    });
    expect(template.Outputs?.HostedZoneId?.Value).toEqual({
      Ref: "HostedZone",
    });
    expect(template.Outputs?.CertificateArn?.Value).toEqual({
      Ref: "Certificate",
    });
  });
});
