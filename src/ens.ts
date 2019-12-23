import { default as ensInterface } from './ens/contract/ens';
import { default as resolverInterface } from './ens/contract/resolver';
import { hash } from 'eth-ens-namehash';
import { formatsByCoinType } from '@ensdomains/address-encoder';
import {
  ResolutionResponse,
  EthCoinIndex,
  NamingServiceSource,
  Bip44Constants,
  isNullAddress,
  IPFS,
  WHOIS,
} from './types';
import { EthereumNamingService } from './namingService';
import { ResolutionError, ResolutionErrorCode } from './index';
import Contract from './utils/contract';
import { throws } from 'assert';

const RegistryMap = {
  mainnet: '0x314159265dd8dbb310642f98f50c066173c1259b',
  ropsten: '0x112234455c3a32fd11230c42e7bccd4a84e02010',
};

/**
 * Class to support connection with Ethereum naming service
 * @param network - network string such as
 * - mainnet
 * - ropsten
 * @param url - main api url such as
 * - https://mainnet.infura.io
 * @param registryAddress - address for a registry contract
 */
export default class Ens extends EthereumNamingService {
  readonly name: string;
  readonly network: string;
  readonly url: string;
  readonly registryAddress?: string;
  /**
   * Source object describing the network naming service operates on
   * @param source - if specified as a string will be used as main url, if omited then defaults are used
   * @throws ConfigurationError - when either network or url is setup incorrectly
   */
  constructor(source: NamingServiceSource = true) {
    super();
    this.name = 'ENS';
    source = this.normalizeSource(source);
    this.network = <string>source.network;
    this.url = source.url;
    if (!this.network) {
      throw new Error('Unspecified network in Resolution ENS configuration');
    }
    if (!this.url) {
      throw new Error('Unspecified url in Resolution ENS configuration');
    }
    this.registryAddress = source.registry
      ? source.registry
      : RegistryMap[this.network];
    if (this.registryAddress) {
      this.registryContract = this.buildContract(
        ensInterface,
        this.registryAddress,
      );
    }
  }

  /**
   * Checks if the domain is in valid format
   * @param domain - domain name to be checked
   */
  isSupportedDomain(domain: string): boolean {
    return (
      domain.indexOf('.') > 0 && /^[a-zA-Z0-9].{1,}[^-]\.(eth|luxe|xyz|test)$/.test(domain)
    );
  }

  /**
   * Checks if the current network is supported
   */
  isSupportedNetwork(): boolean {
    return this.registryAddress != null;
  }

  /** @internal */
  record(domain: string, key: string): Promise<string> {
    throw new Error('Method not implemented.');
  }

  /**
   * Reverse the ens address to a ens registered domain name
   * @async
   * @param address - address you wish to reverse
   * @param currencyTicker - currency ticker like BTC, ETH, ZIL
   * @returns Domain name attached to this address
   */
  async reverse(address: string, currencyTicker: string): Promise<string> {
    if (currencyTicker != 'ETH') {
      throw new Error(`Ens doesn't support any currency other than ETH`);
    }
    if (address.startsWith('0x')) {
      address = address.substr(2);
    }
    const reverseAddress = address + '.addr.reverse';
    const nodeHash = hash(reverseAddress);
    const resolverAddress = await this.getResolver(nodeHash);
    if (isNullAddress(resolverAddress)) {
      return null;
    }
    const resolverContract = this.buildContract(
      resolverInterface(resolverAddress, EthCoinIndex),
      resolverAddress,
    );

    return await this.resolverCallToName(resolverContract, nodeHash);
  }

  /**
   * Resolves domain to a specific cryptoAddress
   * @param domain - domain name to be resolved
   * @param currencyTicker - specific currency ticker such as
   *  - ZIL
   *  - BTC
   *  - ETH
   * @returns A promise that resolves in a string
   * @throws ResolutionError
   */
  async address(domain: string, currencyTicker: string): Promise<string> {
    const nodeHash = this.namehash(domain);
    const ownerPromise = this.owner(domain);
    const resolver = await this.getResolver(nodeHash);
    if (
      !resolver ||
      isNullAddress(resolver)
    ) {
      const owner = await ownerPromise;
      if (!owner || isNullAddress(owner))
        throw new ResolutionError(ResolutionErrorCode.UnregisteredDomain, {
          domain,
        });
      throw new ResolutionError(ResolutionErrorCode.UnspecifiedResolver, {
        domain,
      });
    }
    const coinType = this.getCoinType(currencyTicker.toUpperCase());
    var addr = await this.fetchAddress(resolver, nodeHash, coinType);
    if (!addr)
      throw new ResolutionError(ResolutionErrorCode.UnspecifiedCurrency, {
        domain,
        currencyTicker,
      });
    return addr;
  }

  /**
   * Owner of the domain
   * @param domain - domain name
   * @returns An owner address of the domain
   */
  async owner(domain: string): Promise<string | null> {
    const nodeHash = this.namehash(domain);
    try {
      return await this.getOwner(nodeHash);
    } catch (err) {
      if (
        err instanceof ResolutionError &&
        err.code === ResolutionErrorCode.RecordNotFound
      )
        return null;
      throw err;
    }
  }

  /**
   * Resolves the given domain
   * @async
   * @param domain - domain name to be resolved
   * @returns A promise that resolves in an object
   */
  async resolve(domain: string): Promise<ResolutionResponse | null> {
    if (!this.isSupportedDomain(domain) || !this.isSupportedNetwork()) {
      return null;
    }
    const nodeHash = this.namehash(domain);
    var [owner, ttl, resolver] = await this.getResolutionInfo(domain);
    if (isNullAddress(owner)) owner = null;
    const address = await this.fetchAddress(resolver, nodeHash, EthCoinIndex);
    return {
      addresses: {
        ETH: address,
      },
      meta: {
        owner,
        type: this.name,
        ttl: Number(ttl),
      },
    };
  }

  /**
   * Produces ENS namehash
   * @param domain - domain to be hashed
   * @returns ENS namehash of a domain
   */
  namehash(domain: string): string {
    this.ensureSupportedDomain(domain);
    return hash(domain);
  }

  /**
   * Retrives the ipfs information stored on na ens domain
   * @param domain - domain name
   * @returns 
   *  - hash property ipfs hash
   *  - redirect url
   */
  async ipfs(domain: string): Promise<IPFS> {
    const nodeHash = this.namehash(domain);
    const hash = await this.ipfsHash(nodeHash);
    const redirect = await this.getTextRecord(await this.getResolver(nodeHash), nodeHash, 'url');
    return { hash, redirect };
  }

  /**
   * Retrives the whois information stored on an ens domain
   * @param domain 
   */
  async whois(domain: string): Promise<WHOIS> {
    const nodeHash = this.namehash(domain);
    const resolverAddress = await this.getResolver(nodeHash);
    const resolver = this.buildContract(resolverInterface(resolverAddress, EthCoinIndex), resolverAddress);
    const email = this.getTextRecord(resolver, nodeHash, 'email');
    const url = this.getTextRecord(resolver, nodeHash, 'url');
    const avatar = this.getTextRecord(resolver, nodeHash, 'avatar');
    const description = this.getTextRecord(resolver, nodeHash, 'description');
    const notice = this.getTextRecord(resolver, nodeHash, 'notice');
    const whois = await this.structurePromiseArray({ email, url, avatar, description, notice });
    return whois;
  }

  /**
   * waits for each property of the predicate and returns a resolved object
   * @param predicate - { [key: string]: Promise<string> }
   * @returns - resolved object with same keys
   */
  private async structurePromiseArray(predicate: any) {
    return new Promise(async (resolve, reject) => {
      const entries = Object.entries(predicate);
      Promise.all(entries.map(async ([key, value]: [string, Promise<string>]) => {
        return {
          [key]: await value
        };
      }))
        .then((resolved) => {
          var resolvedObject: { [key: string]: string } = {};
          resolved.map(res => {
            const key = Object.keys(res)[0];
            resolvedObject[key] = res[key];
          });
          resolve(resolvedObject);
        });
    });
  }

  private async ipfsHash(nodeHash): Promise<string> {
    const resolverAddress = await this.getResolver(nodeHash);
    const resolverContract = this.buildContract(resolverInterface(resolverAddress, EthCoinIndex), resolverAddress);
    const contentHashDecoder = require('content-hash');
    const contentHash = await this._getContentHash(resolverContract, nodeHash);
    if (!contentHash)
      // throw ResolutionError ipfs is not connected for the domain
      return contentHashDecoder.decode(contentHash);
  }

  private async getTextRecord(resolver: Contract, nodeHash, key: string): Promise<string> {
    return await this.callMethod(resolver, 'text', [nodeHash, key]);
  }

  // todo(john): mock this in tests!
  private async _getContentHash(resolverContract: Contract, nodeHash) {
    return await this.callMethod(resolverContract, 'contenthash', [nodeHash]);
  }

  /**
   * This was done to make automated tests more configurable
   */
  private async resolverCallToName(resolverContract: Contract, nodeHash) {
    return await this.callMethod(resolverContract, 'name', [nodeHash]);
  }

  private async getTTL(nodeHash) {
    try {
      return await this.callMethod(this.registryContract, 'ttl', [nodeHash]);
    } catch (err) {
      if (err instanceof ResolutionError && err.code === ResolutionErrorCode.RecordNotFound)
        return 0;
      throw err;
    }
  }

  /**
   * This was done to make automated tests more configurable
   */
  async getResolver(nodeHash) {
    try {
      return await this.callMethod(this.registryContract, 'resolver', [nodeHash]);
    } catch (err) {
      if (
        err instanceof ResolutionError &&
        err.code === ResolutionErrorCode.RecordNotFound
      )
        return undefined;
      throw err;
    }
  }

  /**
   * This was done to make automated tests more configurable
   */
  private async getOwner(nodeHash) {
    return await this.callMethod(this.registryContract, 'owner', [nodeHash]);
  }

  /**
   * This was done to make automated tests more configurable
   */
  private async getResolutionInfo(domain: string) {
    const nodeHash = this.namehash(domain);
    return await Promise.all([this.owner(domain), this.getTTL(nodeHash), this.getResolver(nodeHash)]);
  }

  /** @internal */
  protected getCoinType(currencyTicker: string): number {
    const constants: Bip44Constants[] = require('bip44-constants');
    const coin = constants.findIndex(
      item =>
        item[1] === currencyTicker.toUpperCase() ||
        item[2] === currencyTicker.toUpperCase(),
    );
    if (coin < 0 || !formatsByCoinType[coin])
      throw new ResolutionError(ResolutionErrorCode.UnsupportedCurrency, {
        currencyTicker,
      });
    return coin;
  }

  /**
   * @param resolver - resolver address
   * @param nodeHash - namehash of a domain name
   */
  private async fetchAddress(resolver, nodeHash, coinType?: number) {
    if (!resolver || isNullAddress(resolver)) {
      return null;
    }
    const resolverContract = this.buildContract(
      resolverInterface(resolver, coinType),
      resolver,
    );
    const addr: string =
      coinType != EthCoinIndex
        ? await this.callMethod(resolverContract, 'addr', [nodeHash, coinType])
        : await this.callMethod(resolverContract, 'addr', [nodeHash]);
    if (!addr) return null;
    const data = Buffer.from(addr.replace('0x', ''), 'hex');
    return formatsByCoinType[coinType].encoder(data);
  }
}
