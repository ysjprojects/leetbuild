/**
 * Scala helper modules more than one course ships, each course in its own package (`ledger.Tls`,
 * `feed.Tls`, …), keyed by where sbt keeps them. `yarn check:scala` compiles them with the steps.
 */

/** The path of a helper object in a course's Scala support: `ledger`, `Tls` → src/main/scala/ledger/Tls.scala. */
export const scalaPath = (pkg: string, name: string): string =>
  `src/main/scala/${pkg.replace(/\./g, '/')}/${name}.scala`;

/**
 * `Tls.serverContext(certPem, keyPem)`: the server's TLS context from PEM files, as Go's
 * tls.LoadX509KeyPair reads them (the certificate chain, then a PKCS #8 private key, RSA or EC),
 * for Pekko HTTP's `ConnectionContext.httpsServer`.
 */
export const scalaTls = (pkg: string): Record<string, string> => ({
  [scalaPath(pkg, 'Tls')]: `package ${pkg}

import java.io.ByteArrayInputStream
import java.nio.charset.StandardCharsets.US_ASCII
import java.nio.file.{Files, Paths}
import java.security.cert.{Certificate, CertificateFactory}
import java.security.spec.{InvalidKeySpecException, PKCS8EncodedKeySpec}
import java.security.{KeyFactory, KeyStore, PrivateKey}
import java.util.Base64
import javax.net.ssl.{KeyManagerFactory, SSLContext}
import scala.jdk.CollectionConverters._

/** The server's TLS context from PEM files: the certificate chain, then its PKCS #8 private key (RSA or EC). */
object Tls {
  def serverContext(certPem: String, keyPem: String): SSLContext = {
    val chain: Array[Certificate] = CertificateFactory
      .getInstance("X.509")
      .generateCertificates(new ByteArrayInputStream(Files.readAllBytes(Paths.get(certPem))))
      .asScala
      .toArray
    val store = KeyStore.getInstance("PKCS12")
    store.load(null, null)
    store.setKeyEntry("server", privateKey(new String(Files.readAllBytes(Paths.get(keyPem)), US_ASCII)), Array.emptyCharArray, chain)
    val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm)
    keys.init(store, Array.emptyCharArray)
    val context = SSLContext.getInstance("TLS")
    context.init(keys.getKeyManagers, null, null)
    context
  }

  private def privateKey(pem: String): PrivateKey = {
    val spec = new PKCS8EncodedKeySpec(Base64.getMimeDecoder.decode(pem.linesIterator.filterNot(_.startsWith("-----")).mkString))
    try KeyFactory.getInstance("RSA").generatePrivate(spec)
    catch { case _: InvalidKeySpecException => KeyFactory.getInstance("EC").generatePrivate(spec) }
  }
}
`,
});
