import {
    FileCreateTransaction,
    ContractFunctionParameters,
    ContractCreateTransaction,
    EthereumTransaction,
    EthereumTransactionData,
    PrivateKey,
    TransferTransaction,
    Hbar,
    TransactionResponse,
    TransactionReceipt,
    FileId,
    ContractId,
    Status,
    TransactionRecord,
} from "../../src/exports.js";
import { SMART_CONTRACT_BYTECODE } from "./contents.js";
import { encodeRlp } from "ethers";
import IntegrationTestEnv from "./client/NodeIntegrationTestEnv.js";
import * as hex from "../../src/encoding/hex.js";

/**
 * @summary Integration tests for access list support in EIP-2930 (type 1)
 * and EIP-1559 (type 2) Ethereum transactions.
 *
 * @description
 * Verifies that Ethereum transactions with non-empty access lists can be
 * properly encoded, decoded, signed, and submitted to the network.
 * Relates to: https://github.com/hiero-ledger/hiero-sdk-js/issues/3885
 */

describe("EthereumTransactionAccessListIntegrationTest", function () {
    let env, operatorKey, wallet, contractAddress, operatorId;

    beforeAll(async function () {
        env = await IntegrationTestEnv.new();
        wallet = env.wallet;
        operatorKey = wallet.getAccountKey();
        operatorId = wallet.getAccountId();

        // Deploy a contract to interact with
        const fileResponse = await (
            await (
                await new FileCreateTransaction()
                    .setKeys([wallet.getAccountKey()])
                    .setContents(SMART_CONTRACT_BYTECODE)
                    .setMaxTransactionFee(new Hbar(2))
                    .freezeWithSigner(wallet)
            ).signWithSigner(wallet)
        ).executeWithSigner(wallet);
        expect(fileResponse).to.be.instanceof(TransactionResponse);

        const fileReceipt = await fileResponse.getReceiptWithSigner(wallet);
        expect(fileReceipt).to.be.instanceof(TransactionReceipt);
        expect(fileReceipt.status).to.be.equal(Status.Success);
        const fileId = fileReceipt.fileId;
        expect(fileId).to.be.instanceof(FileId);

        const contractResponse = await (
            await (
                await new ContractCreateTransaction()
                    .setAdminKey(operatorKey)
                    .setGas(300_000)
                    .setConstructorParameters(
                        new ContractFunctionParameters()
                            .addString("Hello from Hedera.")
                            ._build(),
                    )
                    .setBytecodeFileId(fileId)
                    .setContractMemo("[e2e::ContractCreateTransaction]")
                    .freezeWithSigner(wallet)
            ).signWithSigner(wallet)
        ).executeWithSigner(wallet);

        expect(contractResponse).to.be.instanceof(TransactionResponse);
        const contractReceipt =
            await contractResponse.getReceiptWithSigner(wallet);
        expect(contractReceipt).to.be.instanceof(TransactionReceipt);
        expect(contractReceipt.status).to.be.equal(Status.Success);
        const contractId = contractReceipt.contractId;
        expect(contractId).to.be.instanceof(ContractId);
        contractAddress = contractId.toEvmAddress();
    });

    it("EIP-1559 (type 2) transaction with non-empty access list", async function () {
        const type = "02";
        const chainId = hex.decode("012a");
        const nonce = new Uint8Array();
        const maxPriorityGas = hex.decode("00");
        const maxGas = hex.decode("d1385c7bf0");
        const gasLimit = hex.decode("0249f0");
        const value = new Uint8Array();
        const to = hex.decode(contractAddress);
        const callData = new ContractFunctionParameters()
            .addString("new message")
            ._build("setMessage");

        // Access list with one entry: contract address + storage slot 0
        const accessList = [
            [
                hex.decode(contractAddress),
                [
                    hex.decode(
                        "0000000000000000000000000000000000000000000000000000000000000000",
                    ),
                ],
            ],
        ];

        const encoded = encodeRlp([
            chainId,
            nonce,
            maxPriorityGas,
            maxGas,
            gasLimit,
            to,
            value,
            callData,
            accessList,
        ]).substring(2);

        const privateKey = PrivateKey.generateECDSA();
        const accountAlias = privateKey.publicKey.toEvmAddress();

        // Fund the ECDSA account
        const transfer = await new TransferTransaction()
            .addHbarTransfer(operatorId, new Hbar(10).negated())
            .addHbarTransfer(accountAlias, new Hbar(10))
            .setMaxTransactionFee(new Hbar(1))
            .freezeWithSigner(wallet);

        const transferResponse = await transfer.executeWithSigner(wallet);
        const transferReceipt =
            await transferResponse.getReceiptWithSigner(wallet);
        expect(transferReceipt.status).to.be.equal(Status.Success);

        // Sign the transaction
        const message = hex.decode(type + encoded);
        const signedBytes = privateKey.sign(message);
        const middleOfSignedBytes = signedBytes.length / 2;
        const r = signedBytes.slice(0, middleOfSignedBytes);
        const s = signedBytes.slice(middleOfSignedBytes, signedBytes.length);
        const recoveryId = privateKey.getRecoveryId(r, s, message);
        const v = new Uint8Array(recoveryId === 0 ? [] : [recoveryId]);

        const data = encodeRlp([
            chainId,
            nonce,
            maxPriorityGas,
            maxGas,
            gasLimit,
            to,
            value,
            callData,
            accessList,
            v,
            r,
            s,
        ]).substring(2);

        const ethereumData = hex.decode(type + data);

        // Verify that EthereumTransactionData.fromBytes correctly parses access list
        const txData = EthereumTransactionData.fromBytes(ethereumData);
        expect(txData.accessList).to.be.an("array");
        expect(txData.accessList.length).to.equal(1);
        expect(txData.accessList[0][0]).to.be.instanceOf(Uint8Array);
        expect(txData.accessList[0][1]).to.be.an("array");
        expect(txData.accessList[0][1].length).to.equal(1);

        // Submit the transaction
        const response = await (
            await (
                await new EthereumTransaction()
                    .setEthereumData(ethereumData)
                    .freezeWithSigner(wallet)
            ).signWithSigner(wallet)
        ).executeWithSigner(wallet);

        const record = await response.getRecordWithSigner(wallet);
        expect(record).to.be.instanceof(TransactionRecord);

        const receipt = await response.getReceiptWithSigner(wallet);
        expect(receipt).to.be.instanceof(TransactionReceipt);
        expect(receipt.status).to.be.equal(Status.Success);
        expect(
            record.contractFunctionResult.signerNonce.toNumber(),
        ).to.be.equal(1);
    });

    it("EIP-1559 (type 2) transaction with multiple access list entries and storage keys", async function () {
        const type = "02";
        const chainId = hex.decode("012a");
        const nonce = new Uint8Array();
        const maxPriorityGas = hex.decode("00");
        const maxGas = hex.decode("d1385c7bf0");
        const gasLimit = hex.decode("0249f0");
        const value = new Uint8Array();
        const to = hex.decode(contractAddress);
        const callData = new ContractFunctionParameters()
            .addString("another message")
            ._build("setMessage");

        // Access list with multiple entries and multiple storage keys
        const accessList = [
            [
                hex.decode(contractAddress),
                [
                    hex.decode(
                        "0000000000000000000000000000000000000000000000000000000000000000",
                    ),
                    hex.decode(
                        "0000000000000000000000000000000000000000000000000000000000000001",
                    ),
                ],
            ],
            [hex.decode("0000000000000000000000000000000000000001"), []],
        ];

        const encoded = encodeRlp([
            chainId,
            nonce,
            maxPriorityGas,
            maxGas,
            gasLimit,
            to,
            value,
            callData,
            accessList,
        ]).substring(2);

        const privateKey = PrivateKey.generateECDSA();
        const accountAlias = privateKey.publicKey.toEvmAddress();

        const transfer = await new TransferTransaction()
            .addHbarTransfer(operatorId, new Hbar(10).negated())
            .addHbarTransfer(accountAlias, new Hbar(10))
            .setMaxTransactionFee(new Hbar(1))
            .freezeWithSigner(wallet);

        const transferResponse = await transfer.executeWithSigner(wallet);
        const transferReceipt =
            await transferResponse.getReceiptWithSigner(wallet);
        expect(transferReceipt.status).to.be.equal(Status.Success);

        const message = hex.decode(type + encoded);
        const signedBytes = privateKey.sign(message);
        const middleOfSignedBytes = signedBytes.length / 2;
        const r = signedBytes.slice(0, middleOfSignedBytes);
        const s = signedBytes.slice(middleOfSignedBytes, signedBytes.length);
        const recoveryId = privateKey.getRecoveryId(r, s, message);
        const v = new Uint8Array(recoveryId === 0 ? [] : [recoveryId]);

        const data = encodeRlp([
            chainId,
            nonce,
            maxPriorityGas,
            maxGas,
            gasLimit,
            to,
            value,
            callData,
            accessList,
            v,
            r,
            s,
        ]).substring(2);

        const ethereumData = hex.decode(type + data);

        // Verify parsing of multi-entry access list
        const txData = EthereumTransactionData.fromBytes(ethereumData);
        expect(txData.accessList).to.be.an("array");
        expect(txData.accessList.length).to.equal(2);
        // First entry: contract address with 2 storage keys
        expect(txData.accessList[0][1].length).to.equal(2);
        // Second entry: address with no storage keys
        expect(txData.accessList[1][1].length).to.equal(0);

        // Verify roundtrip: toBytes -> fromBytes preserves access list
        const roundtripped = EthereumTransactionData.fromBytes(
            txData.toBytes(),
        );
        expect(roundtripped.accessList.length).to.equal(2);
        expect(hex.encode(roundtripped.accessList[0][0])).to.equal(
            hex.encode(txData.accessList[0][0]),
        );

        const response = await (
            await (
                await new EthereumTransaction()
                    .setEthereumData(ethereumData)
                    .freezeWithSigner(wallet)
            ).signWithSigner(wallet)
        ).executeWithSigner(wallet);

        const receipt = await response.getReceiptWithSigner(wallet);
        expect(receipt).to.be.instanceof(TransactionReceipt);
        expect(receipt.status).to.be.equal(Status.Success);
    });

    it("EIP-2930 (type 1) transaction with non-empty access list", async function () {
        const type = "01";
        const chainId = hex.decode("012a");
        const nonce = new Uint8Array();
        const gasPrice = hex.decode("d1385c7bf0");
        const gasLimit = hex.decode("0249f0");
        const value = new Uint8Array();
        const to = hex.decode(contractAddress);
        const callData = new ContractFunctionParameters()
            .addString("eip2930 message")
            ._build("setMessage");

        // Access list with contract address and storage slot
        const accessList = [
            [
                hex.decode(contractAddress),
                [
                    hex.decode(
                        "0000000000000000000000000000000000000000000000000000000000000000",
                    ),
                ],
            ],
        ];

        const encoded = encodeRlp([
            chainId,
            nonce,
            gasPrice,
            gasLimit,
            to,
            value,
            callData,
            accessList,
        ]).substring(2);

        const privateKey = PrivateKey.generateECDSA();
        const accountAlias = privateKey.publicKey.toEvmAddress();

        const transfer = await new TransferTransaction()
            .addHbarTransfer(operatorId, new Hbar(10).negated())
            .addHbarTransfer(accountAlias, new Hbar(10))
            .setMaxTransactionFee(new Hbar(1))
            .freezeWithSigner(wallet);

        const transferResponse = await transfer.executeWithSigner(wallet);
        const transferReceipt =
            await transferResponse.getReceiptWithSigner(wallet);
        expect(transferReceipt.status).to.be.equal(Status.Success);

        const message = hex.decode(type + encoded);
        const signedBytes = privateKey.sign(message);
        const middleOfSignedBytes = signedBytes.length / 2;
        const r = signedBytes.slice(0, middleOfSignedBytes);
        const s = signedBytes.slice(middleOfSignedBytes, signedBytes.length);
        const recoveryId = privateKey.getRecoveryId(r, s, message);
        const v = new Uint8Array(recoveryId === 0 ? [] : [recoveryId]);

        const data = encodeRlp([
            chainId,
            nonce,
            gasPrice,
            gasLimit,
            to,
            value,
            callData,
            accessList,
            v,
            r,
            s,
        ]).substring(2);

        const ethereumData = hex.decode(type + data);

        // Verify that EthereumTransactionData.fromBytes routes to EIP-2930
        // and correctly parses the access list
        const txData = EthereumTransactionData.fromBytes(ethereumData);
        expect(txData.accessList).to.be.an("array");
        expect(txData.accessList.length).to.equal(1);
        expect(txData.accessList[0][0]).to.be.instanceOf(Uint8Array);
        expect(txData.accessList[0][1]).to.be.an("array");
        expect(txData.accessList[0][1].length).to.equal(1);

        // Verify toJSON output format
        const json = txData.toJSON();
        expect(json.accessList).to.be.an("array");
        expect(json.accessList[0]).to.have.property("address");
        expect(json.accessList[0]).to.have.property("storageKeys");
        expect(json.accessList[0].storageKeys).to.be.an("array");
        expect(json.accessList[0].storageKeys.length).to.equal(1);

        const response = await (
            await (
                await new EthereumTransaction()
                    .setEthereumData(ethereumData)
                    .freezeWithSigner(wallet)
            ).signWithSigner(wallet)
        ).executeWithSigner(wallet);

        const receipt = await response.getReceiptWithSigner(wallet);
        expect(receipt).to.be.instanceof(TransactionReceipt);
        expect(receipt.status).to.be.equal(Status.Success);
    });
});
